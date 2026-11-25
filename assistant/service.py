import base64
import contextlib
import hashlib
import io
import json
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
import numpy as np
from speech import DEFAULT_TERMS, LANGUAGES, Models, align, identify, samples, words
from minutes import draft
from vault import Vault


class Problem(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def need(ok, status, message):
    if not ok:
        raise Problem(status, message)


def call(url, token):
    try:
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(req, timeout=4) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise Problem(
            exc.code if exc.code in (401, 403) else 503, "身份或会议状态暂不可用"
        ) from exc
    except (OSError, ValueError) as exc:
        raise Problem(503, "会议服务暂不可用") from exc


SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS glossary(meeting INTEGER PRIMARY KEY, terms TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS voices(meeting INTEGER, uid INTEGER, name TEXT, vec BLOB NOT NULL, PRIMARY KEY(meeting,uid));
CREATE TABLE IF NOT EXISTS captions(id INTEGER PRIMARY KEY, meeting INTEGER, uid INTEGER, nonce TEXT, raw TEXT, text TEXT, lang TEXT, speaker TEXT, speaker_id INTEGER, attribution TEXT, at REAL, UNIQUE(meeting,uid,nonce));
CREATE INDEX IF NOT EXISTS by_meeting ON captions(meeting,id);
CREATE TABLE IF NOT EXISTS translation(segment INTEGER, lang TEXT, text TEXT, PRIMARY KEY(segment,lang));
CREATE TABLE IF NOT EXISTS materials(id TEXT PRIMARY KEY, meeting INTEGER, name TEXT, size INTEGER, digest TEXT, data BLOB, at REAL);
CREATE TABLE IF NOT EXISTS receipts(file TEXT,uid INTEGER,at REAL,PRIMARY KEY(file,uid));
CREATE TABLE IF NOT EXISTS minutes(meeting INTEGER PRIMARY KEY,revision INTEGER,body TEXT,at REAL,editor INTEGER);
CREATE TABLE IF NOT EXISTS consent(meeting INTEGER,uid INTEGER,member TEXT,kinds TEXT,PRIMARY KEY(meeting,uid));
CREATE TABLE IF NOT EXISTS captures(id TEXT PRIMARY KEY,meeting INTEGER,number TEXT,audience TEXT,allowed TEXT,status TEXT,at REAL);
CREATE UNIQUE INDEX IF NOT EXISTS active_capture ON captures(meeting) WHERE status='running';
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,meeting INTEGER,capture TEXT,owner INTEGER,kind TEXT,status TEXT,at REAL,bytes INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY, file TEXT,uid INTEGER,at REAL);
"""


class App:
    def __init__(self, cfg):
        self.cfg = cfg
        self.root = Path(cfg["data"])
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.vault = Vault(self.root / "recordings", base64.b64decode(cfg["key"], validate=True))
        self.models = Models(cfg["models"])
        self.inference = threading.BoundedSemaphore(4)
        self.exports = threading.BoundedSemaphore(2)
        with self.db() as c:
            c.executescript(SCHEMA)

    @contextlib.contextmanager
    def db(self):
        with contextlib.closing(sqlite3.connect(self.root / "assistant.db", timeout=10)) as c:
            c.row_factory = sqlite3.Row
            with c:
                yield c

    def identity(self, token):
        need(0 < len(token) <= 4096, 401, "请登录中卫通会议")
        reply = call(self.cfg["authUrl"], token)
        need(reply.get("code") == 200, 401, "会议登录已过期")
        u = reply.get("data") or {}
        need(isinstance(u.get("id"), int) and u["id"] > 0, 401, "会议用户无效")
        return {
            "id": u["id"],
            "name": str(u.get("displayName") or u.get("username") or u["id"])[:96],
        }

    def activity(self):
        state = call(self.cfg["presenceUrl"], self.cfg["bridge"])
        need(
            isinstance(state.get("rooms"), dict)
            and abs(time.time() - state.get("sampledAt", 0)) < 10,
            503,
            "在会状态暂不可用",
        )
        return state

    def access(self, mid, user, external=""):
        uid = user["id"]
        with contextlib.closing(
            sqlite3.connect(Path(self.cfg["meetings"]).as_uri() + "?mode=ro", uri=True, timeout=3)
        ) as c:
            c.row_factory = sqlite3.Row
            row = c.execute(
                "select ID,TITLE,CREATOR_ID,THIRD_PARTY_MEETING_ID,THIRD_PARTY_MEETING_NUMBER from meeting_appointment where ID=? and DELETED_AT is null",
                (mid,),
            ).fetchone()
            if row:
                number = str(
                    row["THIRD_PARTY_MEETING_NUMBER"] or row["THIRD_PARTY_MEETING_ID"] or ""
                )
                host = row["CREATOR_ID"] == uid
                title = row["TITLE"]
                invited = bool(
                    c.execute(
                        "select 1 from meeting_participant where APPOINTMENT_ID=? and USER_ID=? and DELETED_AT is null",
                        (mid, uid),
                    ).fetchone()
                )
                historical = bool(
                    c.execute(
                        "select 1 from meeting_attendance where USER_ID=? and (APPOINTMENT_ID=? or MEETING_ID=?)",
                        (uid, mid, str(row["THIRD_PARTY_MEETING_ID"] or "-")),
                    ).fetchone()
                )
            else:
                # External rooms use the upstream number and the Go registry FNV-1a session key.
                h = 14695981039346656037
                for b in external.encode():
                    h = ((h ^ b) * 1099511628211) & ((1 << 64) - 1)
                need(
                    re.fullmatch(r"[0-9]{6,12}", external)
                    and mid == ((1 << 52) | ((h & ((1 << 40) - 1)) + 1)),
                    404,
                    "找不到会议",
                )
                number = external
                title = "会议 " + external
                host = invited = False
                historical = bool(
                    c.execute(
                        "select 1 from meeting_attendance where MEETING_ID=? and USER_ID=?",
                        (number, uid),
                    ).fetchone()
                )
        room = self.activity()["rooms"].get(number, {})
        member = next(
            (
                m
                for m in room.get("members", [])
                if m["source"] == "weitong" and str(m["subject"]) == str(uid)
            ),
            None,
        )
        host = host or bool(member and member["host"])
        need(host or invited or historical or member, 403, "没有此会议的访问权限")
        return dict(
            id=mid,
            uid=uid,
            name=user["name"],
            number=number,
            title=title,
            host=host,
            member=member,
            history=bool(host or historical or member),
        )

    def terms(self, c, mid):
        row = c.execute("select terms from glossary where meeting=?", (mid,)).fetchone()
        return {**DEFAULT_TERMS, **(json.loads(row[0]) if row else {})}

    @staticmethod
    def can_export(row, a):
        return a["host"] or (
            a["history"]
            and (
                row["audience"] == "attendees"
                or (row["audience"] == "selected" and a["uid"] in json.loads(row["allowed"]))
            )
        )

    def state(self, a, after=0):
        mid = a["id"]
        uid = a["uid"]
        with self.db() as c:
            consent = c.execute(
                "select kinds from consent where meeting=? and uid=? and member=?",
                (mid, uid, (a["member"] or {}).get("id", "")),
            ).fetchone()
            materials = [
                dict(r)
                for r in c.execute(
                    "select m.id,name,size,digest,at,(select count(*) from receipts where file=m.id) downloads from materials m where meeting=? order by at",
                    (mid,),
                )
            ]
            has = a["history"]
            captions = []
            if has:
                query = "select id,uid,raw,text,lang,speaker,speaker_id,attribution,at from captions where meeting=? and id>? order by id limit 100"
                captions = [dict(r) for r in c.execute(query, (mid, after))]
            minutes = (
                c.execute("select revision,body,at from minutes where meeting=?", (mid,)).fetchone()
                if has
                else None
            )
            running = c.execute(
                "select id,audience,at from captures where meeting=? and status='running'", (mid,)
            ).fetchone()
            files = []
            if has:
                for r in c.execute(
                    "select f.id,f.kind,f.owner,f.status,f.bytes,f.at,c.audience,c.allowed from files f join captures c on c.id=f.capture where f.meeting=? and f.status in ('ready','writing') order by f.at desc",
                    (mid,),
                ):
                    if self.can_export(r, a):
                        item = {k: r[k] for k in ("id", "kind", "owner", "status", "bytes", "at")}
                        item["archived"] = (
                            Path(
                                self.cfg.get(
                                    "archiveReceipts", "/var/lib/weitong-recording-archive/receipts"
                                )
                            )
                            / (r["id"] + ".json")
                        ).is_file()
                        files.append(item)
            return dict(
                meeting=mid,
                title=a["title"],
                host=a["host"],
                live=bool(a["member"]),
                history=has,
                terms=self.terms(c, mid),
                materials=materials,
                captions=captions,
                minutes=dict(minutes) if minutes else None,
                voiceBound=bool(
                    c.execute(
                        "select 1 from voices where meeting=? and uid=?", (mid, uid)
                    ).fetchone()
                ),
                consent=consent[0].split(",") if consent and consent[0] else [],
                capture=dict(running) if running and has else None,
                files=files,
                languages=LANGUAGES,
            )

    def save_terms(self, a, body):
        need(a["host"], 403, "需要主持人权限")
        terms = words(body.get("terms"))
        with self.db() as c:
            c.execute(
                "insert or replace into glossary values(?,?)",
                (a["id"], json.dumps(terms, ensure_ascii=False)),
            )
        return {"count": len(terms)}

    def bind(self, a, blob):
        mid, uid = a["id"], a["uid"]
        if blob is None:
            with self.db() as c:
                c.execute("delete from voices where meeting=? and uid=?", (mid, uid))
            return {"bound": False}
        need(a["member"], 403, "请先入会")
        pcm = samples(blob, 2)
        need(float(np.sqrt(np.mean(pcm**2))) > 0.003, 422, "录音中缺少可用语音")
        with self.slot():
            v = self.models.voice(pcm)
        sealed = self.vault.seal(f"voice/{mid}/{uid}", v.astype("<f4").tobytes())
        with self.db() as c:
            c.execute(
                "insert or replace into voices values(?,?,?,?)", (mid, uid, a["name"], sealed)
            )
        return {"bound": True}

    @contextlib.contextmanager
    def slot(self):
        need(self.inference.acquire(timeout=2), 429, "语音服务繁忙，请重试")
        try:
            yield
        finally:
            self.inference.release()

    def caption(self, a, blob, nonce, language):
        need(a["member"], 403, "请先入会")
        need(re.fullmatch(r"[A-Za-z0-9-]{8,72}", nonce), 400, "需要分段请求 ID")
        mid, uid = a["id"], a["uid"]
        with self.db() as c:
            prev = c.execute(
                "select id from captions where meeting=? and uid=? and nonce=?", (mid, uid, nonce)
            ).fetchone()
            if prev:
                return {"id": prev[0]}
        pcm = samples(blob)
        if float(np.sqrt(np.mean(pcm**2))) < 0.0015:
            return {"id": None}
        with self.slot():
            raw, lang = self.models.hear(pcm, language)
            if not raw:
                return {"id": None}
            with self.db() as c:
                people = [
                    (
                        r["uid"],
                        r["name"],
                        np.frombuffer(
                            self.vault.open(f"voice/{mid}/{r['uid']}", r["vec"]), dtype="<f4"
                        ),
                    )
                    for r in c.execute("select * from voices where meeting=?", (mid,))
                ]
                terms = self.terms(c, mid)
            match = (
                identify(self.models.voice(pcm), people)
                if people and len(pcm) >= 16000 * 1.3
                else None
            )
        speaker_id, name = match or (uid, (a["member"] or {}).get("name") or a["name"])
        with self.db() as c:
            c.execute(
                "insert or ignore into captions(meeting,uid,nonce,raw,text,lang,speaker,speaker_id,attribution,at) values(?,?,?,?,?,?,?,?,?,?)",
                (
                    mid,
                    uid,
                    nonce,
                    raw,
                    align(raw, terms),
                    lang,
                    name,
                    speaker_id,
                    "voice" if match else "microphone",
                    time.time(),
                ),
            )
            return {
                "id": c.execute(
                    "select id from captions where meeting=? and uid=? and nonce=?",
                    (mid, uid, nonce),
                ).fetchone()[0]
            }

    def translate(self, a, segment, lang):
        need(a["history"], 403, "限实际参会人")
        need(lang in LANGUAGES, 400, "不支持的目标语言")
        with self.db() as c:
            row = c.execute(
                "select text,lang from captions where id=? and meeting=?", (segment, a["id"])
            ).fetchone()
            need(row, 404, "未找到发言")
            cached = c.execute(
                "select text from translation where segment=? and lang=?", (segment, lang)
            ).fetchone()
            if cached:
                return {"text": cached[0]}
        need(row["lang"] in LANGUAGES, 422, "该片段未能确定源语言")
        with self.slot():
            text = self.models.translate(row["text"], row["lang"], lang)
        with self.db() as c:
            c.execute("insert or ignore into translation values(?,?,?)", (segment, lang, text))
        return {"text": text}

    def material(self, a, name, data):
        need(a["host"], 403, "需要主持人权限")
        need(
            0 < len(data) <= 16 * 1024**2
            and 0 < len(name) <= 160
            and name == Path(name).name
            and name not in (".", "..")
            and not re.search(r"[\x00-\x1f\\/]", name),
            400,
            "材料名称或大小无效",
        )
        mid = a["id"]
        fid = secrets.token_hex(12)
        digest = hashlib.sha256(data).hexdigest()
        with self.db() as c:
            c.execute("begin immediate")
            size, n = c.execute(
                "select coalesce(sum(size),0),count(*) from materials where meeting=?", (mid,)
            ).fetchone()
            need(
                size + len(data) <= 64 * 1024**2 and n < 64,
                413,
                "本场材料包上限为 64 MiB、64 个文件",
            )
            need(
                not c.execute(
                    "select id from materials where meeting=? and name=?", (mid, name)
                ).fetchone(),
                409,
                "已有同名材料",
            )
            c.execute(
                "insert into materials values(?,?,?,?,?,?,?)",
                (
                    fid,
                    mid,
                    name,
                    len(data),
                    digest,
                    self.vault.seal(f"material/{mid}/{fid}", data),
                    time.time(),
                ),
            )
        return {"id": fid, "sha256": digest}

    def download(self, a, fid=None):
        mid = a["id"]
        buf = io.BytesIO()
        with self.db() as c:
            rows = c.execute(
                "select id,name,data from materials where meeting=?" + (" and id=?" if fid else ""),
                (mid, fid) if fid else (mid,),
            ).fetchall()
            need(rows, 404, "尚无材料")
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
                for r in rows:
                    data = self.vault.open(f"material/{mid}/{r['id']}", r["data"])
                    if not fid:
                        z.writestr(r["name"], data)
                    c.execute(
                        "insert or replace into receipts values(?,?,?)",
                        (r["id"], a["uid"], time.time()),
                    )
        return (rows[0]["name"], data) if fid else ("会议材料包.zip", buf.getvalue())

    def minutes(self, a, body):
        need(a["host"], 403, "需要主持人权限")
        mid = a["id"]
        with self.db() as c:
            c.execute("begin immediate")
            old = c.execute("select revision from minutes where meeting=?", (mid,)).fetchone()
            rev = old[0] if old else 0
            need(body.get("revision", 0) == rev, 409, "纪要已更新，请刷新后重试")
            if body.get("generate") is True:
                rows = c.execute(
                    "select id,text,speaker,at from captions where meeting=? order by id", (mid,)
                ).fetchall()
                need(rows, 409, "已有会议转录后可以生成纪要")
                val = draft(a["title"], rows)
            else:
                val = body.get("body")
            need(isinstance(val, str) and 0 < len(val) <= 240000, 400, "纪要正文长度无效")
            c.execute(
                "insert or replace into minutes values(?,?,?,?,?)",
                (mid, rev + 1, val, time.time(), a["uid"]),
            )
        return {"revision": rev + 1, "body": val}

    def consent(self, a, body):
        need(a["member"], 403, "请先入会")
        kinds = body.get("kinds")
        need(
            isinstance(kinds, list) and all(k in ("camera", "microphone", "screen") for k in kinds),
            400,
            "无效的录制轨道",
        )
        with self.db() as c:
            c.execute(
                "insert or replace into consent values(?,?,?,?)",
                (a["id"], a["uid"], a["member"]["id"], ",".join(sorted(set(kinds)))),
            )
        return {"kinds": kinds}

    def capture(self, a, body, stop=False):
        need(a["host"], 403, "需要主持人权限")
        mid = a["id"]
        with self.db() as c:
            if stop:
                c.execute(
                    "update captures set status='finished' where meeting=? and status='running'",
                    (mid,),
                )
                return {"running": False}
            need(a["member"], 403, "请先入会")
            aud = body.get("audience", "attendees")
            allow = body.get("users", [])
            need(
                aud in ("host", "attendees", "selected")
                and isinstance(allow, list)
                and len(allow) <= 100
                and all(type(x) is int and x > 0 for x in allow)
                and (aud != "selected" or allow),
                400,
                "回放范围无效",
            )
            fid = secrets.token_hex(16)
            try:
                c.execute(
                    "insert into captures values(?,?,?,?,?,'running',?)",
                    (fid, mid, a["number"], aud, json.dumps(allow), time.time()),
                )
            except sqlite3.IntegrityError:
                raise Problem(409, "本场已经在录制")
            return {"running": True, "id": fid}

    def recording(self, a, fid):
        with self.db() as c:
            r = c.execute(
                "select f.*,c.audience,c.allowed from files f join captures c on c.id=f.capture where f.id=? and f.meeting=? and f.status='ready'",
                (fid, a["id"]),
            ).fetchone()
            need(r, 404, "录制文件尚未就绪")
            need(self.can_export(r, a), 403, "不在该录制的回放名单内")
            audit = secrets.token_hex(12)
            c.execute("insert into exports values(?,?,?,?)", (audit, fid, a["uid"], time.time()))
            return dict(r), audit
