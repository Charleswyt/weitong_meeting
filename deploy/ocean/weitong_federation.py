"""Ocean's narrow trust boundary for a Weitong account joining or hosting a common room."""
import base64
import hashlib
import hmac
import ipaddress
import os
from pathlib import Path
import re
import select
import subprocess
import sqlite3
import time
from urllib.parse import urlsplit

PREFIX = 'urn:weitong:'
CONFIG = Path(os.getenv('WEITONG_OCEAN_CONFIG','/etc/weitong-ocean'))
MEETINGS = Path(os.getenv('WEITONG_MEETINGS_DB','/var/lib/weitong-meeting/data/conference.db'))
ACCOUNT_ROUTES = {
    'GET': re.compile(r'/api/(?:conference/meetings/[0-9]{6,12}|frontend/(?:auth/me|conference-management/(?:meetings(?:/[A-Za-z0-9_-]+(?:/playback)?)?|recordings|summary|calendar|contacts)))'),
    'POST': re.compile(r'/api/(?:conference/meetings/join|frontend/conference-management/meetings(?:/quick-start|/[A-Za-z0-9_-]+/(?:start|stop))?)'),
}

def actor(handler):
    raw = handler.frontend_bearer_token()
    if not raw.startswith('wto1.'):
        return None
    if not ipaddress.ip_address(handler.client_address[0]).is_loopback:
        return None
    allowed = ACCOUNT_ROUTES.get(handler.command)
    if not allowed or not allowed.fullmatch(urlsplit(handler.path).path):
        return None
    parts = raw.split('.')
    if len(parts) != 4 or not re.fullmatch(r'[1-9][0-9]{0,17}', parts[1]) or not re.fullmatch(r'[0-9]{10}', parts[2]):
        return None
    exp = int(parts[2])
    if not time.time() < exp <= time.time() + 1805:
        return None
    try:
        secret = (CONFIG / 'account.key').read_bytes().strip()
    except OSError:
        return None
    if len(secret) < 32:
        return None
    proof = hmac.new(secret, '.'.join(parts[:3]).encode(), hashlib.sha256).digest()
    if not hmac.compare_digest(parts[3], base64.urlsafe_b64encode(proof).decode().rstrip('=')):
        return None
    return {'username': PREFIX + parts[1], 'role':'user', 'issuer':'weitong'}

def organizer(user):
    return bool(user and user.get('issuer') == 'weitong' and re.fullmatch(r'urn:weitong:[1-9][0-9]{0,17}', user.get('username','')))

def deny_join(state, number, user, payload):
    room = state.conference_meeting_by_number(number)
    if draining() and (organizer(user) or room and str(room.get('created_by') or '').startswith(PREFIX)):
        return 'meeting_maintenance'
    if not room or not str(room.get('created_by') or '').startswith(PREFIX):
        return ''
    # The business record owns the password and waiting policy. A missing row during
    # publication or a database failure must not open the room to a native client.
    try:
        with sqlite3.connect(MEETINGS.as_uri()+'?mode=ro', uri=True, timeout=2) as db:
            row = db.execute('select creator_id,meeting_password,allow_waiting,status from meeting_appointment where third_party_meeting_number=? and third_party_meeting_id=? and deleted_at is null',(number,room['meeting_id'])).fetchone()
    except (sqlite3.Error,OSError):
        return 'meeting_policy_unavailable'
    if not row or room['created_by'] != PREFIX + str(row[0]):
        return 'meeting_policy_unavailable'
    if row[3] in ('ended','cancelled','failed','deleted'):
        return 'meeting_ended'
    try:
        if capture_since(number) and payload.get('recordingConsent') is not True:
            return 'recording_consent_required'
    except (sqlite3.Error, OSError):
        return 'meeting_policy_unavailable'
    host = organizer(user) and user['username']==room.get('host_username')
    if not host:
        if row[1] and not hmac.compare_digest(str(row[1]).encode(),str(payload.get('password') or '').encode()):
            return 'meeting_password_required'
        if row[2] and not any(p.get('account_name') == room['host_username'] for p in state.list_conference_participants(room['meeting_id'])):
            return 'waiting_for_host'
    return ''


def draining():
    try:
        return float((CONFIG / 'drain').read_text()) > time.time()
    except FileNotFoundError:
        return False
    except (OSError, ValueError):
        return True


def capture_since(number):
    dbfile = Path(os.environ.get('WEITONG_ASSISTANT_DB', '/var/lib/weitong-assistant/assistant.db'))
    with sqlite3.connect(dbfile.as_uri() + '?mode=ro', uri=True, timeout=1) as db:
        row = db.execute("select at from captures where number=? and status='running' order by at desc limit 1", (number,)).fetchone()
        return row[0] if row else 0


def native_activity(handler):
    """Called only by the existing authenticated operations service on loopback."""
    if not ipaddress.ip_address(handler.client_address[0]).is_loopback:
        return 403, {}
    try:
        key = (CONFIG / 'presence.key').read_text().strip()
    except OSError:
        return 503, {}
    if len(key) < 32 or not hmac.compare_digest(handler.headers.get('Authorization', ''), 'Bearer ' + key):
        return 403, {}
    rooms = {}
    with handler.state.conference_db() as conn:
        meetings = conn.execute("""select m.meeting_id,m.meeting_number,m.host_username from conference_meetings m
             where m.status in ('starting','running') and (m.created_by like 'urn:weitong:%' or exists
             (select 1 from conference_participants p where p.meeting_id=m.meeting_id
              and p.status='joined' and p.account_name like 'urn:weitong:%'))""").fetchall()
        for room in meetings:
            mid, number, host = room
            members = []
            tracks = []
            for p in conn.execute("""select participant_id,account_name,display_name,recording_consented_at from
                        conference_participants where meeting_id=? and status='joined'""", (mid,)):
                is_wt = p[1].startswith(PREFIX)
                subject = p[1][len(PREFIX):] if is_wt else p[1]
                members.append(dict(id=p[0], source='weitong' if is_wt else 'ocean', subject=subject,
                                    name=p[2], host=p[1] == host, consentAt=p[3]))
            for t in conn.execute("""select publication_id,participant_id,media_kind,publish_path from
                       conference_publications where meeting_id=? and status in ('registered','publishing','ready')""", (mid,)):
                path = str(t[3] or '')
                allowed = re.fullmatch(r'conference/browser/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+', path)
                ready = allowed is not None and handler.state.rtsp_describe_path_ready(path, timeout_seconds=.2)[0]
                tracks.append(dict(id=t[0], participantId=t[1], kind='microphone' if t[2]=='audio' else t[2],
                                   path='ocean:'+path if allowed else '', ready=ready))
            if members or tracks:
                rooms[number] = dict(members=members, tracks=tracks)
    return 200, {'rooms': rooms, 'sampledAt': time.time()}


def recording_enabled(meeting):
    if meeting.get('cloud_record'):
        return True
    if not str(meeting.get('created_by') or '').startswith(PREFIX):
        return False
    return bool(capture_since(str(meeting.get('meeting_number') or '')))


def original_track(state, publication, owner=None):
    if (not publication or publication.get('source_type') != 'browser_whip'
            or publication.get('status') not in ('publishing', 'ready', 'registered')
            or not publication.get('has_video') or publication.get('cloud_lane_id')):
        return False
    if owner is None:
        owner = state.conference_participant_by_id(publication['participant_id']) or {}
    return str(owner.get('account_name') or '').startswith(PREFIX)


def legacy_offer(state, publication, owner, viewer, payload):
    if not viewer or not original_track(state, publication, owner):
        return
    if payload.get('hdWhepUrl'):
        payload['cloudWhepUrl'] = payload['hdWhepUrl']
    if str(viewer.get('account_name') or '').startswith(PREFIX):
        return
    path = str(publication.get('publish_path') or '')
    ready = state.rtsp_describe_path_ready(path, timeout_seconds=.2)[0]
    payload.update(directDeliveryMode='compressed_au_https',
                   directVideoUrl='/api/conference/direct-media/'+publication['publication_id']+'/video',
                   directVideoCodec='h264', directVideoFormat='zha1_h264_annexb', directVideoReady=ready,
                   browserDeliveryMode='local_h264_decode', cloudVideoTranscode=False)
    if ready:
        payload.update(status='ready', hdReady=True)


def serve_original(handler, pubid, kind, participant_token):
    """Forward original H.264 access units to same-room Ocean clients requesting its direct video format."""
    if kind != 'video':
        return False
    state = handler.state
    member, reason = state.verify_conference_participant_token(participant_token)
    if not member:
        handler.send_json(401, {'ok': False, 'reason': reason})
        return True
    pub = state.conference_publication_by_id(pubid)
    if not pub:
        return False
    if pub['meeting_id'] != member['meeting_id']:
        handler.send_json(403, {'ok': False, 'reason': 'publication_meeting_mismatch'})
        return True
    path = pub['publish_path']
    if not original_track(state, pub):
        # Some Ocean publishers register a cloud encoder but leave preparation to the first viewer.
        if (str(member.get('account_name') or '').startswith(PREFIX)
                and pub.get('status') in ('registered', 'publishing', 'ready')
                and pub.get('cloud_lane_id') and state.conference_browser_software_roi_enabled(pub)
                and state.rtsp_describe_path_ready(path, timeout_seconds=.2)[0]):
            with state._worker_lock:
                state.ensure_conference_software_roi_worker(pub)
        return False
    if not re.fullmatch(r'conference/browser/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+', path):
        handler.send_json(409, {'ok': False, 'reason': 'invalid_media_path'})
        return True
    if not state.rtsp_describe_path_ready(path, timeout_seconds=.3)[0]:
        handler.send_json(425, {'ok':False, 'reason':'direct_video_not_ready'})
        return True
    ticket = state.conference_media_ticket(pub, actions=['read'], media_path=path)
    address = 'http://127.0.0.1:'+str(state.cfg.webrtc_port)+'/'+path+'/whep?'+state.conference_media_query(pub,ticket=ticket,role='consumer')
    reader = CONFIG / 'media-reader'
    if not reader.is_file():
        handler.send_json(503, {'ok':False, 'reason':'media_reader_unavailable'})
        return True
    proc = subprocess.Popen([str(reader), '-whep-capture', 'env:WEITONG_WHEP', '-zha-output','-',
                             '-capture-width',str(pub['width']),'-capture-height',str(pub['height']),
                             '-capture-fps',str(pub['fps'])], env=dict(os.environ,WEITONG_WHEP=address),
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        if not select.select([proc.stdout],[],[],13)[0] or proc.stdout.read(4) != b'ZHA1':
            handler.send_json(425, {'ok':False, 'reason':'direct_video_not_ready'})
            return True
        handler.send_response(200)
        handler.send_header('Content-Type','application/vnd.zwt.zha1+h264')
        handler.send_header('Cache-Control','no-store')
        handler.send_header('X-Accel-Buffering', 'no')
        handler.send_header('X-ZWT-Media-Format', 'zha1_h264_annexb')
        handler.send_header('X-ZWT-Cloud-Transcode', '0')
        handler.send_header('Connection','close')
        handler.end_headers()
        handler.close_connection = True
        handler.connection.settimeout(8)
        handler.wfile.write(b'ZHA1')
        last_check = last_data = time.monotonic()
        while time.monotonic() - last_data < 15:
            if time.monotonic() - last_check >= 3:
                current, _ = state.verify_conference_participant_token(participant_token)
                if not current or current['meeting_id'] != pub['meeting_id']:
                    break
                last_check = time.monotonic()
            if not select.select([proc.stdout], [], [], 1)[0]:
                continue
            data = proc.stdout.read1(65536)
            if not data:
                break
            last_data = time.monotonic()
            handler.wfile.write(data)
            handler.wfile.flush()
    except (BrokenPipeError, ConnectionError,TimeoutError):
        pass
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        proc.stdout.close()
    return True
