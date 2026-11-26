import argparse
import json
import os
import re
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlsplit
from service import App, Problem, need
from vault import CloudCapture, watermarked
from live_speech import LiveSpeech


class Handler(BaseHTTPRequestHandler):
    server_version = "WeitongAssistant/1"

    def log_message(self, *args):
        pass

    def send_data(self, code, data, ctype="application/json", name=None):
        if isinstance(data, dict):
            data = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "private, no-store")
        if name:
            self.send_header(
                "Content-Disposition", "attachment; filename*=UTF-8''" + quote(name, safe="")
            )
        self.end_headers()
        self.wfile.write(data)

    def read(self, mime, limit):
        need(
            self.headers.get("Content-Type", "").split(";")[0].strip() == mime, 415, "请求格式无效"
        )
        need(not self.headers.get("Transfer-Encoding"), 400, "请指定正文长度")
        size = int(self.headers.get("Content-Length", "0"))
        need(0 <= size <= limit, 413, "请求体过大")
        data = self.rfile.read(size)
        need(len(data) == size, 400, "请求不完整")
        return data

    def obj(self):
        obj = json.loads(self.read("application/json", 800000) or "{}")
        need(isinstance(obj, dict), 400, "需要 JSON 对象")
        return obj

    def route(self):
        app = self.server.app
        parsed = urlsplit(self.path)
        if self.command == "GET" and parsed.path == "/health":
            return self.send_data(200, {"ok": True})
        if parsed.path == "/zwt-meeting/assist/v1/settings/glossary" and self.command in (
            "GET",
            "PUT",
        ):
            bearer = self.headers.get("Authorization", "")
            need(bearer.startswith("Bearer "), 401, "请登录中卫通会议")
            user = app.identity(bearer[7:])
            return self.send_data(
                200, app.personal_terms(user["id"], self.obj() if self.command == "PUT" else None)
            )
        m = re.fullmatch(
            r"/zwt-meeting/assist/v1/meetings/(\d{1,16})/(state|terms|transcription|sharing|voice|captions|translations|materials|package|minutes|consent|capture|files)(?:/([a-z0-9-]{1,48}))?",
            parsed.path,
        )
        need(m, 404, "无此接口")
        mid = int(m[1])
        action = m[2]
        arg = m[3]
        bearer = self.headers.get("Authorization", "")
        need(bearer.startswith("Bearer "), 401, "请登录中卫通会议")
        q = parse_qs(parsed.query)

        def query(k, d=""):
            return q.get(k, [d])[0]

        identity = app.identity(bearer[7:])
        a = app.access(mid, identity, query("number"))
        verb = self.command
        if verb == "GET" and action == "state" and not arg:
            result = app.state(a, max(0, int(query("after", "0"))))
        elif verb == "PUT" and (action, arg) == ("transcription", None):
            result = app.transcription(a, self.obj().get("enabled"))
        elif verb == "PUT" and action == "sharing" and arg:
            result = app.share(a, arg, self.obj().get("users"))
        elif verb == "PUT" and (action, arg) == ("terms", None):
            result = app.save_terms(a, self.obj())
        elif (action, arg) == ("voice", None) and verb in ("PUT", "DELETE"):
            result = app.bind(a, None if verb == "DELETE" else self.read("audio/wav", 540000))
        elif verb == "POST" and (action, arg) == ("captions", None):
            result = app.caption(
                a,
                self.read("audio/wav", 540000),
                self.headers.get("Idempotency-Key", ""),
                query("language"),
            )
        elif verb == "GET" and action == "translations" and arg and arg.isdigit():
            result = app.translate(a, int(arg), query("lang"))
        elif verb == "POST" and (action, arg) == ("materials", None):
            need(a["host"], 403, "需要主持人权限")
            result = app.material(
                a,
                unquote(self.headers.get("X-File-Name", "")),
                self.read("application/octet-stream", 16 * 1024**2),
            )
        elif verb == "GET" and (
            (action == "materials" and arg) or (action, arg) == ("package", None)
        ):
            name, data = app.download(a, arg)
            return self.send_data(
                200,
                data,
                "application/zip" if action == "package" else "application/octet-stream",
                name,
            )
        elif verb == "PUT" and (action, arg) == ("minutes", None):
            result = app.minutes(a, self.obj())
        elif verb == "GET" and (action, arg) == ("minutes", "export"):
            need(a["history"], 403, "限实际参会人")
            need(a["ended"], 409, "会议结束后整理纪要")
            with app.db() as c:
                r = c.execute("select body from minutes where meeting=?", (mid,)).fetchone()
            need(r, 404, "尚无已发布纪要")
            return self.send_data(200, r[0].encode(), "text/markdown; charset=utf-8", "会议纪要.md")
        elif verb == "PUT" and (action, arg) == ("consent", None):
            result = app.consent(a, self.obj())
        elif (action, arg) == ("capture", None) and verb in ("POST", "DELETE"):
            result = app.capture(a, self.obj() if verb == "POST" else {}, verb == "DELETE")
        elif verb == "GET" and action == "files" and arg:
            r, audit = app.recording(a, arg)
            need(app.exports.acquire(blocking=False), 429, "已有录制导出任务，请稍后重试")
            try:
                with tempfile.TemporaryFile() as export:
                    # Feed authenticated plaintext through a kernel pipe, never through a cleartext recording on disk.
                    reader, writer = os.pipe()
                    errors = []
                    with os.fdopen(reader, "rb") as clear:
                        number = a["number"] if re.fullmatch(r"[0-9]{6,12}", a["number"]) else mid
                        process = watermarked(
                            clear, r["kind"], number, a["uid"], arg, audit, export
                        )

                    def feed():
                        try:
                            with os.fdopen(writer, "wb") as out:
                                app.vault.decrypt_to(arg, mid, out)
                        except Exception as exc:
                            errors.append(type(exc).__name__)

                    decryptor = threading.Thread(target=feed, daemon=True)
                    decryptor.start()
                    try:
                        ret = process.wait(timeout=min(3600, 90 + r["bytes"] // 80000))
                    finally:
                        if process.poll() is None:
                            process.kill()
                            process.wait()
                        decryptor.join(5)
                    need(
                        ret == 0 and not errors and not decryptor.is_alive() and export.tell() > 0,
                        503,
                        "水印导出未完成，请稍后重试",
                    )
                    size = export.tell()
                    export.seek(0)
                    self.send_response(200)
                    self.send_header("Content-Length", str(size))
                    self.send_header("Content-Type", "video/mp4")
                    self.send_header(
                        "Content-Disposition",
                        f'attachment; filename="WT-{mid}-{arg[:10]}-{audit[:8]}.mp4"',
                    )
                    self.send_header("Cache-Control", "private, no-store")
                    self.end_headers()
                    import shutil

                    shutil.copyfileobj(export, self.wfile, 65536)
            finally:
                app.exports.release()
            return
        else:
            raise Problem(405, "请求方法无效")
        self.send_data(200, result)

    def handle_api(self):
        try:
            self.route()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Problem as e:
            self.send_data(e.status, {"message": str(e)})
        except (ValueError, UnicodeError) as e:
            self.send_data(400, {"message": str(e)[:180]})
        except Exception as e:
            import sys

            print("Assistant request failed:", type(e).__name__, file=sys.stderr, flush=True)
            self.send_data(503, {"message": "会议助手暂时不可用，请重试"})

    do_GET = do_POST = do_PUT = do_DELETE = handle_api


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("config")
    args = parser.parse_args()
    with open(args.config) as f:
        cfg = json.load(f)
    os.umask(0o077)
    app = App(cfg)
    worker = CloudCapture(app)
    thread = threading.Thread(target=worker.run, daemon=True)
    thread.start()
    captions = LiveSpeech(app, worker)
    threading.Thread(target=captions.run, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", int(cfg.get("port", 19917))), Handler)
    server.app = app
    try:
        server.serve_forever()
    finally:
        worker.stop.set()
        captions.stop.set()
        server.server_close()


if __name__ == "__main__":
    main()
