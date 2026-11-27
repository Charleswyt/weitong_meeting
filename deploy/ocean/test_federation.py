import base64
import hashlib
import hmac
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import weitong_federation as f


class Federation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.enter = patch.object(f, 'CONFIG', self.root)
        self.enter.start()
        self.addCleanup(self.enter.stop)
        (self.root/'account.key').write_bytes(b'x'*32)

    def test_separate_identity_and_routes(self):
        text = 'wto1.45.' + str(int(time.time()) + 60)
        sig = base64.urlsafe_b64encode(hmac.digest(b'x'*32, text.encode(), hashlib.sha256)).decode().rstrip('=')
        req = SimpleNamespace(frontend_bearer_token=lambda: text+'.'+sig, command='POST',
                              path='/api/conference/meetings/join',client_address=('127.0.0.1',1234))
        self.assertEqual(f.actor(req), dict(username='urn:weitong:45', role='user', issuer='weitong'))
        req.path='/api/frontend/devices'
        self.assertIsNone(f.actor(req))
        req.path='/api/conference/meetings/join'
        req.client_address=('192.0.2.42',1234)
        self.assertIsNone(f.actor(req))

    def test_admission_of_other_frontends(self):
        db=self.root/'wt.db'
        with sqlite3.connect(db) as c:
            c.executescript("""create table meeting_appointment(creator_id,meeting_password,allow_waiting,status,
                third_party_meeting_number,third_party_meeting_id,deleted_at);
                insert into meeting_appointment values(45,'abc',1,'running','12345678','native-id',null);""")
        room=dict(meeting_id='native-id', host_username=f.PREFIX+'45', created_by=f.PREFIX+'45')
        users=[]
        state=SimpleNamespace(conference_meeting_by_number=lambda n: room,list_conference_participants=lambda mid: users)
        with patch.object(f,'MEETINGS',db),patch.object(f,'capture_since',return_value=0):
            user=dict(username='45',role='user')
            self.assertEqual(f.deny_join(state,'12345678',user,{}),'meeting_password_required')
            self.assertEqual(f.deny_join(state,'12345678',user,{'password':'abc'}),'waiting_for_host')
            users.append({'account_name':f.PREFIX+'45'})
            self.assertEqual(f.deny_join(state,'12345678',user,{'password':'abc'}),'')
            with patch.object(f,'capture_since',return_value=time.time()):
                self.assertEqual(f.deny_join(state,'12345678',user,{'password':'abc'}),'recording_consent_required')
                self.assertEqual(f.deny_join(state,'12345678',user,{'password':'abc','recordingConsent':True}),'')
            (self.root/'drain').write_text(str(time.time()+60))
            self.assertEqual(f.deny_join(state,'12345678',user,{}),'meeting_maintenance')

    def test_original_video_is_advertised_only_to_room_viewers(self):
        owner = {'account_name': f.PREFIX + '45'}
        pub = dict(participant_id='source', publication_id='p1', meeting_id='m1', has_video=True,
                   publish_path='conference/browser/m1/p1', source_type='browser_whip',
                   status='publishing', cloud_lane_id=0)
        state = SimpleNamespace(rtsp_describe_path_ready=lambda *args, **kw: (True, ''))
        native = {'account_name': 'operator'}
        payload = {'hdWhepUrl': '/test/whep'}
        f.legacy_offer(state, pub, owner, None, payload)
        self.assertNotIn('directVideoUrl', payload)
        f.legacy_offer(state, pub, owner, owner, payload)
        self.assertEqual(payload['cloudWhepUrl'], '/test/whep')
        self.assertNotIn('directVideoUrl', payload)
        f.legacy_offer(state, pub, owner, native, payload)
        self.assertEqual(payload['directVideoUrl'], '/api/conference/direct-media/p1/video')
        self.assertTrue(payload['directVideoReady'])
        self.assertFalse(payload['cloudVideoTranscode'])
        responses = []
        state.conference_publication_by_id = lambda pid: pub
        state.verify_conference_participant_token = lambda _: ({'meeting_id': 'different'}, '')
        request = SimpleNamespace(state=state, send_json=lambda status, body: responses.append(status))
        self.assertTrue(f.serve_original(request, 'p1', 'video', 'x'))
        state.verify_conference_participant_token = lambda _: (None, 'invalid_token')
        self.assertTrue(f.serve_original(request, 'p1', 'video', 'x'))
        self.assertEqual(responses, [403, 401])
