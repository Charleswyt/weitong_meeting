"""Prepare the native Ocean adapter from its installed source without changing the running process."""
import argparse
from pathlib import Path
import subprocess
import tempfile


def patched(text):
    delta = Path(__file__).with_name("ocean-meetings.patch").read_bytes()
    with tempfile.TemporaryDirectory() as temp:
        native = Path(temp) / "dev_cloud_backend.py"
        native.write_text(text)
        args = ["patch", "--force", "--fuzz=0", "--no-backup-if-mismatch", native.name]
        if "import weitong_federation" in text:
            reverse = subprocess.run([*args, "--reverse", "--dry-run"], cwd=temp,
                                     input=delta, capture_output=True)
            if reverse.returncode == 0:
                return text
            raise ValueError("An older Ocean integration is installed. Reapply to its saved original source.")
        forward = subprocess.run(args, cwd=temp, input=delta, capture_output=True)
        if forward.returncode:
            raise ValueError("Ocean's meeting adapter changed. Review the patch against the installed revision.")
        result = native.read_text()
        compile(result, native.name, "exec")
        return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.write_text(patched(args.source.read_text()))
