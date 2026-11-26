"""Transcribe each published meeting microphone once while anyone is watching captions."""

import logging
import secrets
import subprocess
import threading
import time

import numpy as np


def utterances(source):
    frames = []
    spoken = quiet = 0
    started = 0
    while True:
        data = source.read(3200)  # 100 ms, 16 kHz PCM16 mono
        if not data:
            if spoken >= 3:
                yield started, np.concatenate(frames)
            return
        frame = np.frombuffer(data[: len(data) // 2 * 2], dtype="<i2").astype(np.float32) / 32768
        if not frame.size:
            continue
        audible = float(np.sqrt(np.mean(frame * frame))) > 0.006
        if not frames:
            if not audible:
                continue
            started = time.time() - len(frame) / 16000
        frames.append(frame)
        spoken += int(audible)
        quiet = 0 if audible else quiet + 1
        if len(frames) >= 60 or quiet >= 6:
            if spoken >= 3:
                yield started, np.concatenate(frames)
            frames = []
            spoken = quiet = 0


class LiveSpeech:
    def __init__(self, app, media):
        self.app = app
        self.media = media
        self.active = {}
        self.retry = {}
        self.stop = threading.Event()

    def wanted(self):
        with self.app.db() as c:
            viewers = c.execute("select * from caption_viewers").fetchall()
        rooms = self.app.activity()["rooms"] if viewers else {}
        meetings = {}
        with self.app.db() as c:
            for v in viewers:
                room = rooms.get(v["number"], {})
                people = {m["id"]: m for m in room.get("members", []) if m["source"] == "weitong"}
                person = people.get(v["member"])
                if not person or str(person["subject"]) != str(v["uid"]):
                    c.execute(
                        "delete from caption_viewers where meeting=? and member=? and uid=?",
                        (v["meeting"], v["member"], v["uid"]),
                    )
                    continue
                meetings[v["meeting"]] = (v, people, room)
        wanted = {}
        for mid, (v, people, room) in meetings.items():
            for track in room.get("tracks", []):
                person = people.get(track["participantId"])
                if track["kind"] != "microphone" or not track["ready"] or not person:
                    continue
                key = (mid, person["id"], track["id"], track["path"])
                wanted[key] = dict(
                    id=mid,
                    uid=int(person["subject"]),
                    name=person["name"],
                    member=person,
                    title=v["title"],
                )
        return wanted

    def start(self, key, speaker):
        proc = subprocess.Popen(
            [
                "/usr/bin/ffmpeg",
                "-nostdin",
                "-loglevel",
                "error",
                "-rtsp_transport",
                "tcp",
                self.media.socket_timeout,
                "8000000",
                "-analyzeduration",
                "200000",
                "-probesize",
                "32768",
                "-i",
                self.media.media_uri(key[3]),
                "-map",
                "0:a:0",
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-f",
                "s16le",
                "pipe:1",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        cancelled = threading.Event()

        def consume():
            try:
                with proc.stdout as reader:
                    for at, pcm in utterances(reader):
                        if cancelled.is_set():
                            break
                        self.app.caption_pcm(speaker, pcm, secrets.token_hex(16), "auto", at)
            except Exception:
                logging.exception("Meeting microphone transcription stopped")
            finally:
                if proc.poll() is None:
                    proc.kill()
                proc.wait()

        thread = threading.Thread(target=consume, daemon=True)
        self.active[key] = (proc, cancelled, thread)
        thread.start()

    def reconcile(self, wanted):
        now = time.monotonic()
        for key, (proc, cancelled, thread) in list(self.active.items()):
            if key not in wanted:
                cancelled.set()
                if proc.poll() is None:
                    proc.terminate()
            if not thread.is_alive():
                del self.active[key]
                self.retry[key] = now + 3
        self.retry = {k: at for k, at in self.retry.items() if k in wanted and at > now}
        for key, speaker in wanted.items():
            if key not in self.active and key not in self.retry:
                self.start(key, speaker)

    def run(self):
        next_minutes = 0
        try:
            while not self.stop.is_set():
                try:
                    self.reconcile(self.wanted())
                except Exception:
                    self.reconcile({})
                    logging.exception("Meeting microphone status unavailable")
                if time.monotonic() >= next_minutes:
                    try:
                        self.app.finish_minutes()
                    except Exception:
                        logging.exception("Meeting minutes will be retried")
                    next_minutes = time.monotonic() + 5
                self.stop.wait(1)
        finally:
            self.reconcile({})
