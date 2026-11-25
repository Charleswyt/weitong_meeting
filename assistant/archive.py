"""Replicate completed encrypted recordings to the existing private OSS archive."""

import argparse
import contextlib
import grp
import hashlib
import json
import os
import pwd
import re
import sqlite3
import stat
import sys
import tempfile
from pathlib import Path


def run(config, data, state):
    with open(config) as f:
        settings = json.load(f)
    sys.path.insert(0, settings["clientDirectory"])
    from oss_archive import OssClient

    with open(settings["archiveConfig"]) as f:
        storage = json.load(f)
    state.mkdir(mode=0o750, parents=True, exist_ok=True)
    receipts = state / "receipts"
    receipts.mkdir(mode=0o750, exist_ok=True)
    gid = grp.getgrnam("weitong-meeting").gr_gid
    for directory in (state, receipts):
        os.chown(directory, 0, gid)
        os.chmod(directory, 0o750)
    work = state / "transfer"
    work.mkdir(mode=0o700, exist_ok=True)
    for folder in ("reports", "checkpoints"):
        (work / folder).mkdir(mode=0o700, exist_ok=True)
    client = OssClient(storage, work)
    archived = 0
    with contextlib.closing(
        sqlite3.connect((data / "assistant.db").as_uri() + "?mode=ro", uri=True, timeout=10)
    ) as db:
        rows = list(db.execute("select id,meeting from files where status='ready' order by at"))
    owner = pwd.getpwnam("weitong-meeting").pw_uid
    directory = os.open(data / "recordings", os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for fid, mid in rows:
            if (
                not isinstance(fid, str)
                or not re.fullmatch("[0-9a-f]{32}", fid)
                or type(mid) is not int
                or mid <= 0
            ):
                continue
            receipt = receipts / (fid + ".json")
            if receipt.is_file():
                continue
            obj = "weitong-meeting/recordings/v1/" + str(mid) + "/" + fid + ".enc"
            with tempfile.NamedTemporaryFile(dir=work, prefix="encrypted-") as frozen:
                with os.fdopen(
                    os.open(
                        fid + ".enc", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
                    ),
                    "rb",
                ) as src:
                    fs = os.fstat(src.fileno())
                    if (
                        not stat.S_ISREG(fs.st_mode)
                        or fs.st_uid != owner
                        or fs.st_nlink != 1
                        or src.read(7) != b"WTREC1\0"
                    ):
                        raise ValueError("invalid encrypted spool file")
                    src.seek(0)
                    digest = hashlib.sha256()
                    for block in iter(lambda: src.read(1024 * 1024), b""):
                        digest.update(block)
                        frozen.write(block)
                frozen.flush()
                crc = client.put_verified(Path(frozen.name), obj, digest.hexdigest())
            tmp = receipt.with_suffix(".tmp")
            tmp.write_text(
                json.dumps(
                    {"key": obj, "bytes": fs.st_size, "sha256": digest.hexdigest(), "crc64": crc}
                )
            )
            os.chown(tmp, 0, gid)
            tmp.chmod(0o640)
            os.replace(tmp, receipt)
            archived += 1
            if archived >= 4:
                break
    finally:
        os.close(directory)
    return archived


if __name__ == "__main__":
    os.umask(0o077)
    p = argparse.ArgumentParser()
    p.add_argument("config")
    args = p.parse_args()
    count = run(
        args.config, Path("/var/lib/weitong-assistant"), Path("/var/lib/weitong-recording-archive")
    )
    if count:
        print("Verified encrypted recording objects:", count)
