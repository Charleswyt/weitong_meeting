import base64
import hashlib
import io
import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from service import App, Problem
from speech import DEFAULT_TERMS, align, words
from vault import watermarked
from cryptography.exceptions import InvalidTag


class Features(unittest.TestCase):
    def setUp(self):
        t = tempfile.TemporaryDirectory()
        self.addCleanup(t.cleanup)
        self.d = Path(t.name)
        self.business = self.d / "business.db"
        with sqlite3.connect(self.business) as c:
            c.executescript("""create table meeting_appointment(ID integer,TITLE,CREATOR_ID,THIRD_PARTY_MEETING_ID,THIRD_PARTY_MEETING_NUMBER,DELETED_AT);
            create table meeting_participant(APPOINTMENT_ID,USER_ID,DELETED_AT);create table meeting_attendance(APPOINTMENT_ID,USER_ID,MEETING_ID);
            insert into meeting_appointment values(7,'测试',1,'1234567890','1234567890',null),(8,'他场',8,'2234567890','2234567890',null);
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
        self.assertEqual(self.app.download(self.invited, file["id"]), ("议程.pdf", b"only-once"))
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
            self.assertNotIn(b"only-once", c.execute("select data from materials").fetchone()[0])

    def test_glossary_and_edit_conflict(self):
        self.assertEqual(
            align("卡卫星通信，边云协调 / 洛拉微调 升腾芯片 D C U 水电栈 船舶CCPD", DEFAULT_TERMS),
            "Ka 卫星通信，边云协同 / LoRA微调 昇腾芯片 DCU 水电站 船舶 CCPD",
        )
        self.app.save_terms(self.host, {"terms": "标准词,别名\n雷达,雷达儿|蕾达"})
        self.assertEqual(self.app.state(self.host)["terms"]["雷达"], ["雷达儿", "蕾达"])
        with self.app.db() as c:
            c.execute(
                "insert into captions(meeting,text,speaker,at) values(7,'我负责周五提交','乙',1000)"
            )
        out = self.app.minutes(self.host, {"generate": True})
        self.assertIn("行动项", out["body"])
        self.assertIn("乙", out["body"])
        self.assertIn("#1", out["body"])
        with self.assertRaises(Problem):
            self.app.minutes(self.host, {"revision": 0, "body": "覆盖"})
        self.assertIsNone(self.app.state(self.invited)["minutes"])
        self.assertEqual(
            self.app.minutes(self.host, {"revision": 1, "body": "修订稿"})["revision"], 2
        )

    def test_capture_access_consent_and_granular_watermark(self):
        job = self.app.capture(self.host, {"audience": "selected", "users": [2]})
        fid = "1" * 32
        self.app.consent(self.guest, {"kinds": ["microphone"]})
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
        digests = []
        for a in (self.host, self.guest):
            row, audit = self.app.recording(a, fid)
            with tempfile.TemporaryFile() as clear:
                self.app.vault.decrypt_to(fid, 7, clear)
                self.assertEqual(
                    hashlib.sha256(clear.read()).digest(), hashlib.sha256(video).digest()
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
        self.app.capture(self.host, {}, True)

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
