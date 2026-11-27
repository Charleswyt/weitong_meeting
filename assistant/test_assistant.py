import base64
import hashlib
import io
import os
import sqlite3
import subprocess
import tempfile
import unittest
import zipfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from service import App, Problem
from speech import DEFAULT_TERMS, align
from vault import CloudCapture, watermarked
from server import wait_export
from live_speech import LiveSpeech
from cryptography.exceptions import InvalidTag


class Features(unittest.TestCase):
    def setUp(self):
        t = tempfile.TemporaryDirectory()
        self.addCleanup(t.cleanup)
        self.d = Path(t.name)
        self.business = self.d / "business.db"
        with sqlite3.connect(self.business) as c:
            c.executescript("""create table meeting_appointment(ID integer,TITLE,CREATOR_ID,THIRD_PARTY_MEETING_ID,THIRD_PARTY_MEETING_NUMBER,DELETED_AT,STATUS);
            create table meeting_participant(APPOINTMENT_ID,USER_ID,DELETED_AT);create table meeting_attendance(APPOINTMENT_ID,USER_ID,MEETING_ID);
            insert into meeting_appointment values(7,'测试',1,'1234567890','1234567890',null,'running'),(8,'他场',8,'2234567890','2234567890',null,'running');
            insert into meeting_participant values(7,2,null),(7,3,null);
            insert into meeting_attendance values(7,2,'1234567890');""")
        self.app = App(
            dict(
                key=base64.b64encode(os.urandom(32)),
                data=str(self.d / "app"),
                meetings=str(self.business),
                models=os.environ.get("WT_MODELS", "/unused"),
            )
        )
        self.roster = {
            "rooms": {
                "1234567890": {
                    "members": [
                        {
                            "source": "weitong",
                            "subject": "1",
                            "id": "aa",
                            "name": "甲",
                            "host": True,
                        },
                        {
                            "source": "weitong",
                            "subject": "2",
                            "id": "bb",
                            "name": "乙",
                            "host": False,
                        },
                    ],
                    "tracks": [],
                }
            }
        }
        patcher = patch.object(self.app, "activity", return_value=self.roster)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.host = self.user(1)
        self.guest = self.user(2)
        self.invited = self.user(3)

    def user(self, i):
        return self.app.access(7, {"id": i, "name": "测试" + str(i)})

    def test_materials_pre_meeting_bundle_and_isolation(self):
        file = self.app.material(self.host, "议程.pdf", b"only-once")
        self.assertEqual(
            self.app.download(self.invited, file["id"]), ("议程.pdf", b"only-once")
        )
        _, z = self.app.download(self.invited)
        self.assertEqual(zipfile.ZipFile(io.BytesIO(z)).read("议程.pdf"), b"only-once")
        self.assertEqual(self.app.state(self.host)["materials"][0]["downloads"], 1)
        with self.assertRaises(Problem):
            self.app.material(self.guest, "other", b"x")
        with self.assertRaises(Problem):
            self.app.access(8, {"id": 1, "name": "A"})
        with self.assertRaises(Problem):
            self.app.material(self.host, "../escape", b"x")
        with self.app.db() as c:
            self.assertNotIn(
                b"only-once", c.execute("select data from materials").fetchone()[0]
            )

    def test_glossary_and_edit_conflict(self):
        self.assertEqual(
            align(
                "卡卫星通信，边云协调 / 洛拉微调 升腾芯片 D C U 水电栈 船舶CCPD",
                DEFAULT_TERMS,
            ),
            "Ka 卫星通信，边云协同 / LoRA微调 昇腾芯片 DCU 水电站 船舶 CCPD",
        )
        self.app.save_terms(self.host, {"terms": "标准词,别名\n雷达,雷达儿|蕾达"})
        self.assertEqual(self.app.state(self.host)["terms"]["雷达"], ["雷达儿", "蕾达"])
        with self.app.db() as c:
            c.execute(
                "insert into captions(meeting,text,speaker,at) values(7,'我负责周五提交','乙',1000)"
            )
        with self.assertRaises(Problem):
            self.app.minutes(self.host, {"generate": True})
        with self.app.db() as c:
            c.execute("insert into pending_minutes values(7,'测试')")
        self.app.finish_minutes()
        self.assertEqual(self.app.state(self.host)["minutesStatus"], "processing")
        self.assertIsNone(self.app.state(self.host)["minutes"])
        with sqlite3.connect(self.business) as c:
            c.execute("update meeting_appointment set STATUS='ended' where ID=7")
        self.host = self.user(1)
        self.app.finish_minutes()
        out = self.app.state(self.host)["minutes"]
        self.assertIn("行动项", out["body"])
        self.assertIn("乙", out["body"])
        self.assertIn("#1", out["body"])
        with self.assertRaises(Problem):
            self.app.minutes(self.host, {"revision": 0, "body": "覆盖"})
        self.assertIsNone(self.app.state(self.invited)["minutes"])
        self.assertEqual(
            self.app.minutes(self.host, {"revision": 1, "body": "修订稿"})["revision"],
            2,
        )

    def test_capture_access_consent_and_granular_watermark(self):
        with self.assertRaises(Problem):
            self.app.capture(self.host, {"audience": "attendees"})
        job = self.app.capture(self.host, {})
        self.assertEqual(self.app.state(self.guest)["consent"], [])
        self.assertEqual(
            set(self.app.state(self.host)["consent"]),
            {"microphone", "screen", "camera"},
        )
        fid = "1" * 32
        self.app.consent(self.guest, {"captureId": job["id"], "kinds": ["microphone"]})
        self.assertEqual(self.app.state(self.guest)["consent"], ["microphone"])
        video = subprocess.check_output(
            [
                "/usr/bin/ffmpeg",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=black:s=480x160:r=10:d=1",
                "-c:v",
                "libx264",
                "-threads",
                "1",
                "-f",
                "matroska",
                "pipe:1",
            ]
        )
        self.app.vault.write_stream(fid, 7, io.BytesIO(video), 1000000)
        with self.app.db() as c:
            c.execute(
                "insert into files values(?,7,?,2,'camera','ready',1,?)",
                (fid, job["id"], len(video)),
            )
        with self.assertRaises(Problem):
            self.app.recording(self.invited, fid)
        with self.assertRaises(Problem):
            self.app.recording(self.guest, fid)
        with self.assertRaises(Problem):
            self.app.share(self.host, job["id"], [2])
        self.app.capture(self.host, {}, True)
        with self.assertRaises(Problem):
            self.app.share(self.guest, job["id"], [2])
        self.app.share(self.host, job["id"], [2])
        digests = []
        for a in (self.host, self.guest):
            row, audit = self.app.recording(a, fid)
            with tempfile.TemporaryFile() as clear:
                self.app.vault.decrypt_to(fid, 7, clear)
                self.assertEqual(
                    hashlib.sha256(clear.read()).digest(),
                    hashlib.sha256(video).digest(),
                )
                clear.seek(0)
                proc = watermarked(clear, "camera", 7, a["uid"], fid, audit)
                output, _ = proc.communicate(timeout=15)
                self.assertEqual(proc.returncode, 0)
            raw = subprocess.check_output(
                [
                    "/usr/bin/ffmpeg",
                    "-loglevel",
                    "error",
                    "-i",
                    "pipe:0",
                    "-vframes",
                    "1",
                    "-threads",
                    "1",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "gray",
                    "pipe:1",
                ],
                input=output,
            )
            digests.append(hashlib.sha256(raw).digest())
        self.assertNotEqual(*digests)
        path = self.app.vault.dir / (fid + ".enc")
        blob = path.read_bytes()
        self.assertNotIn(video[0:26], blob)
        path.write_bytes(blob[:-20])
        with self.assertRaises((ValueError, InvalidTag)):
            self.app.vault.decrypt_to(fid, 7, io.BytesIO())
        self.app.share(self.host, job["id"], [])
        with self.assertRaises(Problem):
            self.app.recording(self.guest, fid)
        self.app.capture(self.host, {})
        self.assertEqual(self.app.state(self.guest)["consent"], [])
        with self.assertRaises(Problem):
            self.app.consent(self.guest, {"captureId": job["id"], "kinds": ["screen"]})

    def test_repeated_capture_with_delayed_start_and_stop(self):
        start = lambda fid, prev: self.app.capture(
            self.host, {"captureId": fid, "previousCaptureId": prev}
        )
        stop = lambda fid: self.app.capture(self.host, {"captureId": fid}, True)
        first, second, stale = "1" * 32, "2" * 32, "3" * 32
        with ThreadPoolExecutor(4) as pool:
            for result in pool.map(lambda _: start(first, None), range(4)):
                self.assertEqual(result, {"id": first, "running": True})
        self.app.consent(self.guest, {"captureId": first, "kinds": ["camera"]})
        stop(first)
        start(second, first)
        self.assertEqual(stop(first), {"id": first, "running": False})
        self.assertFalse(start(first, None)["running"])
        self.assertEqual(self.app.state(self.guest)["consent"], [])
        self.assertEqual(self.app.state(self.host)["capture"]["id"], second)
        with self.assertRaises(Problem):
            self.app.capture(self.host, {}, True)
        with self.assertRaises(Problem):
            self.app.capture(self.guest, {"captureId": second}, True)
        stop(second)
        with self.assertRaises(Problem):
            start(stale, None)
        state = self.app.state(self.host)
        self.assertIsNone(state["capture"])
        self.assertEqual(state["lastCaptureId"], second)
        self.assertEqual(
            [r["finishReason"] for r in state["managedCaptures"]], ["host_stop"] * 2
        )

    def test_roster_loss_empty_timeout_and_meeting_end(self):
        worker = CloudCapture(self.app)
        first = self.app.capture(self.host, {})["id"]
        worker.empty_since[first] = time.monotonic() - 301
        worker.tick()
        self.assertNotIn(first, worker.empty_since)
        with patch.object(self.app, "activity", side_effect=Problem(503, "offline")):
            with self.assertRaises(Problem):
                self.user(1)
            offline = self.app.access(
                7, {"id": 1, "name": "甲"}, allow_offline_stop=True
            )
            self.assertFalse(offline["member"])
        self.roster["rooms"].clear()
        worker.tick()
        self.assertEqual(self.app.state(self.host)["capture"]["id"], first)
        worker.empty_since[first] -= 301
        worker.tick()
        self.assertEqual(
            self.app.state(self.host)["managedCaptures"][0]["finishReason"],
            "empty_timeout",
        )
        second = self.app.capture(self.host, {})["id"]
        with sqlite3.connect(self.business) as c:
            c.execute("update meeting_appointment set status='ended' where id=7")
        worker.tick()
        self.assertEqual(
            self.app.state(self.host)["managedCaptures"][0]["finishReason"],
            "meeting_ended",
        )
        self.assertFalse(
            self.app.capture(self.host, {"captureId": second}, True)["running"]
        )

    def test_restart_recovers_authenticated_draft_and_current_capture(self):
        fid, cid = "a" * 32, self.app.capture(self.host, {})["id"]
        video = subprocess.check_output(
            [
                "/usr/bin/ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=96x64:rate=8",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-threads",
                "1",
                "-f",
                "matroska",
                "pipe:1",
            ]
        )
        vault = self.app.vault
        vault.write_stream(fid, 7, io.BytesIO(video), 1000000)
        out = vault.dir / (fid + ".enc")
        part = vault.dir / (fid + ".part")
        part.write_bytes(out.read_bytes()[:-10])
        out.unlink()
        with self.app.db() as c:
            c.execute(
                "insert into files values(?,7,?,1,'camera','writing',1,0)", (fid, cid)
            )
        worker = CloudCapture(self.app)
        worker.recover()
        state = self.app.state(self.host)
        self.assertEqual(state["capture"]["id"], cid)
        self.assertEqual(state["files"][0]["status"], "ready")
        self.assertEqual(state["files"][0]["captureId"], cid)
        self.assertEqual(state["files"][0]["bytes"], len(video))
        self.assertFalse(part.exists())
        dst = io.BytesIO()
        vault.decrypt_to(fid, 7, dst)
        self.assertEqual(dst.read(), video)

    def test_export_progress_and_idle_timeout(self):
        def run(src):
            return subprocess.Popen(
                ["/usr/bin/python3", "-u", "-c", src], stderr=subprocess.PIPE
            )

        p = run(
            "import sys,time\nfor i in range(12):\n print('frame='+str(i), file=sys.stderr);time.sleep(.1)"
        )
        self.assertEqual(
            wait_export(p, lambda: True, idle_seconds=0.6, max_seconds=4), 0
        )
        p = run("import time;time.sleep(10)")
        with self.assertRaises(Problem) as exc:
            wait_export(p, lambda: True, idle_seconds=0.1, max_seconds=4)
        self.assertEqual(exc.exception.status, 504)
        self.assertIsNotNone(p.poll())

    def test_captions_follow_all_publishers_not_viewer_microphone(self):
        r = self.roster["rooms"]["1234567890"]
        for i, kind, owner in [
            ("1", "camera", "aa"),
            ("2", "microphone", "aa"),
            ("3", "microphone", "bb"),
        ]:
            r["tracks"].append(
                dict(
                    id=i,
                    kind=kind,
                    participantId=owner,
                    path="fixture/" + i,
                    ready=True,
                )
            )
        worker = LiveSpeech(self.app, None)
        self.assertFalse(worker.wanted())
        self.app.transcription(self.guest, True)
        self.assertEqual({s["uid"] for s in worker.wanted().values()}, {1, 2})
        self.app.transcription(self.host, True)
        self.assertEqual(len(worker.wanted()), 2)
        self.app.transcription(self.host, False)
        self.assertTrue(self.app.state(self.host)["transcription"]["active"])
        self.assertFalse(self.app.state(self.host)["transcription"]["enabled"])
        r["members"] = [r["members"][0]]
        self.assertFalse(worker.wanted())
        with self.assertRaises(Problem):
            self.app.transcription(self.invited, True)
        self.app.personal_terms(1, {"terms": {"词": ["主持人别名"]}})
        self.app.personal_terms(2, {"terms": {"词": ["别场"]}})
        self.assertEqual(self.app.state(self.host)["terms"]["词"], ["主持人别名"])
        self.app.save_terms(self.host, {"terms": {"词": ["本场"]}})
        self.assertEqual(self.app.state(self.host)["terms"]["词"], ["本场"])

    @unittest.skipUnless(os.environ.get("WT_MODELS"), "speech model fixtures")
    def test_real_speech_voice_binding_translation_and_revoke(self):
        path = Path(os.environ["WT_MODELS"])
        en = (path / "en.wav").read_bytes()
        zh = (path / "zh.wav").read_bytes()
        self.app.bind(self.guest, en)
        first = self.app.caption(self.host, en, "test-chunk-one", "")
        self.assertEqual(first, self.app.caption(self.host, en, "test-chunk-one", ""))
        second = self.app.caption(self.host, zh, "test-chunk-two", "")
        rows = self.app.state(self.host)["captions"]
        self.assertEqual([r["lang"] for r in rows], ["en", "zh"])
        self.assertEqual(rows[0]["attribution"], "voice")
        self.assertEqual(rows[0]["speaker_id"], 2)
        self.assertEqual(rows[1]["attribution"], "microphone")
        self.assertTrue(self.app.translate(self.guest, first["id"], "zh")["text"])
        self.assertTrue(self.app.translate(self.guest, second["id"], "en")["text"])
        self.app.bind(self.guest, None)
        self.assertFalse(self.app.state(self.guest)["voiceBound"])
        self.assertFalse(self.app.state(self.invited)["captions"])


if __name__ == "__main__":
    unittest.main()
