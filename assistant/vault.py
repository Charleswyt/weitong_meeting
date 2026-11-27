import re
import hashlib
import hmac
import os
import secrets
import signal
import shutil
import struct
import subprocess
import threading
import time
import sqlite3
from contextlib import closing
from pathlib import Path
from urllib.parse import quote
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.exceptions import InvalidTag

MAGIC = b"WTREC1\0"
CHUNK = 65536


class Vault:
    def __init__(self, directory, key):
        self.dir = Path(directory)
        self.dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        if len(key) != 32:
            raise RuntimeError("invalid assistant encryption key")
        self.key = key

    def cipher(self, label):
        return AESGCM(hmac.new(self.key, label.encode(), hashlib.sha256).digest())

    def seal(self, label, data):
        nonce = secrets.token_bytes(12)
        return nonce + self.cipher(label).encrypt(nonce, data, label.encode())

    def open(self, label, encrypted):
        return self.cipher(label).decrypt(
            encrypted[:12], encrypted[12:], label.encode()
        )

    def write_stream(self, file_id, meeting, source, max_bytes):
        read = getattr(source, "read1", source.read)
        return self._write(
            file_id, meeting, iter(lambda: read(CHUNK), b""), max_bytes, ".part"
        )

    def _write(self, file_id, meeting, chunks, max_bytes, suffix):
        label = f"record/{meeting}/{file_id}"
        cipher = self.cipher(label)
        temp = self.dir / (file_id + suffix)
        total = index = 0
        try:
            with temp.open("xb") as dest:
                prefix = os.urandom(8)
                dest.write(MAGIC + prefix)
                flushed = time.monotonic()
                for data in chunks:
                    if index % 128 == 0 and shutil.disk_usage(self.dir).free < 1024**3:
                        raise ValueError("录制存储余量不足")
                    total += len(data)
                    if total > max_bytes:
                        raise ValueError("录制文件已达单文件上限")
                    nonce = prefix + struct.pack(">I", index)
                    block = cipher.encrypt(nonce, data, label.encode() + nonce)
                    dest.write(struct.pack(">I", len(block)) + block)
                    index += 1
                    if time.monotonic() - flushed >= 2:
                        dest.flush()
                        flushed = time.monotonic()
                if not total:
                    raise ValueError("没有收到媒体")
                # Authenticated final marker protects even against complete-chunk truncation.
                nonce = prefix + struct.pack(">I", index)
                tail = cipher.encrypt(nonce, b"", label.encode() + nonce + b"final")
                dest.write(struct.pack(">I", len(tail)) + tail)
                dest.flush()
                os.fsync(dest.fileno())
            temp.replace(self.dir / (file_id + ".enc"))
            return total
        finally:
            temp.unlink(missing_ok=True)

    def _blocks(self, file_id, meeting, path, draft=False):
        label = f"record/{meeting}/{file_id}"
        cipher = self.cipher(label)
        with path.open("rb") as src:
            if src.read(len(MAGIC)) != MAGIC:
                raise ValueError("录制文件头无效")
            prefix = src.read(8)
            if len(prefix) != 8:
                raise ValueError("录制文件头不完整")
            index = 0
            while True:
                size = src.read(4)
                if len(size) != 4:
                    if draft:
                        return
                    raise ValueError("录制文件不完整")
                (length,) = struct.unpack(">I", size)
                if not 16 <= length <= CHUNK + 16:
                    raise ValueError("录制文件分块错误")
                nonce = prefix + struct.pack(">I", index)
                block = src.read(length)
                if draft and len(block) < length:
                    return
                final = length == 16
                data = cipher.decrypt(
                    nonce, block, label.encode() + nonce + (b"final" if final else b"")
                )
                if final:
                    if src.read(1):
                        raise ValueError("录制文件尾错误")
                    break
                yield data
                index += 1

    def recover_draft(self, file_id, meeting):
        # Only an outstanding database writer may recover its unpublished spool.
        # Re-encrypt authenticated whole blocks with a fresh nonce prefix.
        part = self.dir / (file_id + ".part")
        recovering = self.dir / (file_id + ".recovering")
        recovering.unlink(missing_ok=True)
        return self._write(
            file_id,
            meeting,
            self._blocks(file_id, meeting, part, draft=True),
            2 * 1024**3,
            ".recovering",
        )

    def decrypt_to(self, file_id, meeting, dest):
        size = 0
        for data in self._blocks(file_id, meeting, self.dir / (file_id + ".enc")):
            dest.write(data)
            size += len(data)
        if dest.seekable():
            dest.seek(0)
        return size


def watermarked(
    source, kind, meeting, user, recording, audit, target=None, progress=False
):
    # Identifiers come exclusively from the service. Draw them into the delivered pixels.
    label = f"WT {meeting}  UID {user}\nREC {recording[:12]}\nCOPY {audit[:16]}"
    overlay = (
        "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='"
        + label
        + "':fontsize=max(8\\,min(20\\,min(w/23\\,h/9))):fontcolor=white:box=1:boxcolor=black@0.62:boxborderw=4:"
        "x=8+mod(floor(t/5)*73\\,max(1\\,w-tw-18)):y=8+mod(floor(t/5)*39\\,max(1\\,h-th-18)),"
        "pad=ceil(iw/2)*2:ceil(ih/2)*2"
    )
    args = [
        "/usr/bin/ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-filter_threads",
        "1",
        "-i",
        f"pipe:{source.fileno()}",
    ]
    if kind in ("microphone", "audio"):
        args += [
            "-f",
            "lavfi",
            "-i",
            "color=size=640x160:rate=5:color=0x23324a",
            "-map",
            "1:v:0",
            "-map",
            "0:a:0",
            "-shortest",
        ]
    else:
        # Screen sharing can have a 1 kHz time base and irregularly spaced frames.
        # Keep the captured timestamps when burning the per-viewer watermark.
        args += ["-map", "0:v:0", "-map", "0:a:0?", "-vsync", "vfr"]
    args += [
        "-vf",
        overlay,
        "-c:v",
        "libx264",
        "-threads",
        "2",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "24",
        "-c:a",
        "aac",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "-f",
        "mp4",
        "pipe:1",
    ]
    if progress:
        args[1:1] = ["-nostats", "-progress", "pipe:2"]
    return subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=target or subprocess.PIPE,
        stderr=subprocess.PIPE if progress else subprocess.DEVNULL,
        pass_fds=(source.fileno(),),
    )


def verify_media(vault, file_id, meeting, kind):
    """Verify all encrypted blocks and count packets of the requested track."""
    probe = subprocess.Popen(
        [
            "/usr/bin/ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0" if kind == "microphone" else "v:0",
            "-count_packets",
            "-show_entries",
            "stream=nb_read_packets",
            "-of",
            "csv=p=0",
            "pipe:0",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    # ffprobe only emits the small count at EOF. Cap its lifetime even if it
    # stops consuming the pipe. Vault.decrypt_to also checks the final marker.
    timer = threading.Timer(180, probe.kill)
    timer.start()
    try:
        with probe.stdin as target:
            size = vault.decrypt_to(file_id, meeting, target)
        with probe.stdout as out:
            result = out.read(128).strip()
        return size if probe.wait() == 0 and result.isdigit() and int(result) > 0 else 0
    except (OSError, ValueError, InvalidTag):
        return 0
    finally:
        timer.cancel()
        if probe.poll() is None:
            probe.kill()
        probe.wait()
        probe.stdout.close()


class Reader:
    def __init__(self, process, track):
        self.process = process
        self.member = track["participantId"]
        self.kind = track["kind"]
        self.last_progress = time.monotonic()
        self.stopping = None

    def interrupt(self, now):
        if self.process.poll() is not None:
            return
        if self.stopping is None:
            self.stopping = now
            self.process.send_signal(signal.SIGINT)
        elif now - self.stopping >= 8:
            self.process.kill()


class CloudCapture:
    def __init__(self, app):
        self.app = app
        self.active = {}
        self.mutex = threading.Lock()
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.retry = {}
        self.empty_since = {}
        # FFmpeg 4.x uses -timeout for listening as an RTSP server. Its client option is -stimeout.
        rtsp_help = subprocess.check_output(
            ["/usr/bin/ffmpeg", "-hide_banner", "-h", "demuxer=rtsp"],
            text=True,
            stderr=subprocess.STDOUT,
        )
        self.socket_timeout = "-stimeout" if "  -stimeout " in rtsp_help else "-timeout"

        with self.app.db() as c:
            self.orphaned_writes = c.execute(
                "select id,meeting,kind from files where status='writing'"
            ).fetchall()

    def recover(self):
        for row in self.orphaned_writes:
            fid, mid, kind = row
            sealed = self.app.vault.dir / (fid + ".enc")
            part = self.app.vault.dir / (fid + ".part")
            size, status = 0, "interrupted"
            try:
                if not sealed.exists() and part.is_file():
                    self.app.vault.recover_draft(fid, mid)
                if sealed.is_file():
                    size = verify_media(self.app.vault, fid, mid, kind)
                if size:
                    status = "ready"
            except (ValueError, OSError, InvalidTag, struct.error):
                pass
            with self.app.db() as c:
                c.execute(
                    "update files set status=?,bytes=? where id=? and status='writing'",
                    (status, size, fid),
                )
            if status == "ready":
                part.unlink(missing_ok=True)

    def media_uri(self, path):
        cfg = self.app.cfg
        if path.startswith("ocean:"):
            native = path.removeprefix("ocean:")
            if not re.fullmatch(
                r"conference/browser/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+", native
            ):
                raise ValueError("无效的公共会场媒体路径")
            return f"rtsp://127.0.0.1:{int(cfg['oceanRtspPort'])}/{native}"
        return f"rtsp://{quote(cfg['mediaUser'], safe='')}:{quote(cfg['mediaPassword'], safe='')}@127.0.0.1:{int(cfg['rtspPort'])}/{path}"

    def action(self, key, job, track):
        fid = secrets.token_hex(16)
        app = self.app
        uri = self.media_uri(track["path"])
        cmd = [
            "/usr/bin/ffmpeg",
            "-nostdin",
            "-loglevel",
            "error",
            "-nostats",
            "-progress",
            "pipe:2",
            "-rtsp_transport",
            "tcp",
            self.socket_timeout,
            "15000000",
            "-analyzeduration",
            "750000",
            "-probesize",
            "524288",
            "-i",
            uri,
            "-map",
            "0:v?",
            "-map",
            "0:a?",
            "-c",
            "copy",
            "-f",
            "matroska",
            "-cluster_time_limit",
            "1000",
            "-flush_packets",
            "1",
            "pipe:1",
        ]
        with self.mutex:
            with app.db() as c:
                c.execute("begin immediate")
                if not c.execute(
                    "select 1 from captures where id=? and status='running'",
                    (job["id"],),
                ).fetchone():
                    return
                if track["owner"]:
                    consent = c.execute(
                        "select kinds from capture_consent where capture=? and member=? and uid=?",
                        (job["id"], track["participantId"], track["owner"]),
                    ).fetchone()
                    if not consent or track["kind"] not in consent[0].split(","):
                        return
                c.execute(
                    "insert into files(id,meeting,capture,owner,kind,status,at) values(?,?,?,?,?,'writing',?)",
                    (
                        fid,
                        job["meeting"],
                        job["id"],
                        track["owner"],
                        track["kind"],
                        time.time(),
                    ),
                )
                process = subprocess.Popen(
                    cmd,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
            reader = self.active[key] = Reader(process, track)
        progress = {"frame": 0, "out_time_us": 0}

        def meter():
            with process.stderr as channel:
                for line in channel:
                    key, _, val = line.strip().partition(b"=")
                    if key in (b"frame", b"out_time_us") and val.strip().isdigit():
                        field = key.decode("ascii")
                        if int(val) > progress[field]:
                            progress[field] = int(val)
                            reader.last_progress = time.monotonic()

        metrics = threading.Thread(target=meter, daemon=True)
        metrics.start()

        def save():
            size = 0
            try:
                with process.stdout as stream:
                    size = app.vault.write_stream(
                        fid, job["meeting"], stream, 2 * 1024**3
                    )
                code = process.wait(timeout=8)
                metrics.join(2)
                real_media = progress["out_time_us"] > 0 and (
                    track["kind"] == "microphone" or progress["frame"] > 0
                )
                if not (
                    code in (0, 255, -signal.SIGINT) and real_media
                ) and not verify_media(app.vault, fid, job["meeting"], track["kind"]):
                    raise ValueError("未收到可播放的媒体帧")
                status = "ready"
            except Exception:
                process.kill()
                process.wait()
                status = (
                    "interrupted"
                    if (app.vault.dir / (fid + ".enc")).is_file()
                    else "failed"
                )
            finally:
                with app.db() as c:
                    c.execute(
                        "update files set status=?,bytes=? where id=?",
                        (status, size, fid),
                    )
                with self.mutex:
                    self.active.pop(key, None)
                    self.retry[key] = time.monotonic() + 4

        threading.Thread(target=save, daemon=True).start()

    def changed(self, capture_id=None, member=None, kinds=()):
        now = time.monotonic()
        with self.mutex:
            for key, reader in self.active.items():
                if key[0] == capture_id and (
                    member is None
                    or reader.member == member
                    and reader.kind not in kinds
                ):
                    reader.interrupt(now)
        self.wake.set()

    def tick(self):
        with self.app.db() as c:
            jobs = [
                dict(r)
                for r in c.execute("select * from captures where status='running'")
            ]
        ended = set()
        if jobs:
            with closing(
                sqlite3.connect(
                    Path(self.app.cfg["meetings"]).as_uri() + "?mode=ro",
                    uri=True,
                    timeout=3,
                )
            ) as business:
                ended = {
                    job["id"]
                    for job in jobs
                    if business.execute(
                        "select 1 from meeting_appointment where id=? and (status in ('ended','cancelled','failed') or deleted_at is not null)",
                        (job["meeting"],),
                    ).fetchone()
                }
        with self.app.db() as c:
            for fid in ended:
                if c.execute(
                    "update captures set status='finished' where id=? and status='running'",
                    (fid,),
                ).rowcount:
                    c.execute(
                        "insert or ignore into capture_finish values(?,?,'meeting_ended',null)",
                        (fid, time.time()),
                    )
        jobs = [job for job in jobs if job["id"] not in ended]
        state = self.app.activity()["rooms"] if jobs else {}
        wanted = {}
        self.empty_since = {
            job["id"]: self.empty_since[job["id"]]
            for job in jobs
            if job["id"] in self.empty_since
        }
        with self.app.db() as c:
            for job in jobs:
                room = state.get(job["number"], {})
                if not room.get("members"):
                    empty = self.empty_since.setdefault(job["id"], time.monotonic())
                    if time.monotonic() - empty >= 300:
                        changed = c.execute(
                            "update captures set status='finished' where id=? and status='running'",
                            (job["id"],),
                        ).rowcount
                        if changed:
                            c.execute(
                                "insert or ignore into capture_finish values(?,?,'empty_timeout',null)",
                                (job["id"], time.time()),
                            )
                    continue
                self.empty_since.pop(job["id"], None)
                owner = {
                    m["id"]: m["subject"]
                    for m in room["members"]
                    if m["source"] == "weitong"
                }
                native = {m["id"]: m for m in room["members"] if m["source"] == "ocean"}
                for t in room["tracks"]:
                    uid = owner.get(t["participantId"])
                    guest = native.get(t["participantId"])
                    if guest and float(guest["consentAt"]) >= job["at"] and t["ready"]:
                        # An Ocean account cannot log into the Weitong replay ACL. Its files belong to the recording.
                        wanted[(job["id"], t["id"], t["path"])] = (
                            job,
                            dict(t, owner=0),
                        )
                    if not uid or not t["ready"]:
                        continue
                    permission = c.execute(
                        "select kinds from capture_consent where capture=? and uid=? and member=?",
                        (job["id"], uid, t["participantId"]),
                    ).fetchone()
                    if permission and t["kind"] in permission[0].split(","):
                        wanted[(job["id"], t["id"], t["path"])] = (
                            job,
                            dict(t, owner=uid),
                        )
        with self.mutex:
            curr = dict(self.active)
            for key in list(self.retry):
                if key not in wanted:
                    self.retry.pop(key, None)
            now = time.monotonic()
            for key, reader in curr.items():
                if (
                    key not in wanted
                    or reader.stopping is not None
                    or now - reader.last_progress >= 45
                ):
                    reader.interrupt(now)
        for key, (job, track) in wanted.items():
            if key not in curr and self.retry.get(key, 0) <= time.monotonic():
                try:
                    self.action(key, job, track)
                except (OSError, ValueError, subprocess.SubprocessError):
                    # One unavailable publication must not interrupt the other tracks.
                    with self.mutex:
                        self.retry[key] = time.monotonic() + 4

    def run(self):
        if self.orphaned_writes:
            threading.Thread(target=self.recover, daemon=True).start()
        while not self.stop.is_set():
            self.wake.clear()
            try:
                self.tick()
            except Exception:
                # Lost consent/roster visibility: stop readers and verify again after reconnection.
                self.empty_since.clear()
                with self.mutex:
                    for reader in self.active.values():
                        reader.interrupt(time.monotonic())
            self.wake.wait(1.5)
        while True:
            with self.mutex:
                if not self.active:
                    return
                for reader in self.active.values():
                    reader.interrupt(time.monotonic())
            time.sleep(0.15)
