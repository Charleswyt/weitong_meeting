"""Gate a disruptive Weitong release on the live room service. Run on the cloud host."""

import argparse
import json
from pathlib import Path
from urllib.request import Request, urlopen


def drain(method):
    settings = json.loads(Path("/etc/sinosat-meeting/config.json").read_bytes())
    url = "http://127.0.0.1:%d/internal/weitong/drain" % settings["port"]
    with urlopen(
        Request(
            url,
            method=method,
            headers={"Authorization": "Bearer " + settings["weitongBridgeToken"]},
        ),
        timeout=5,
    ) as response:
        return json.load(response)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("acquire", "release"))
    args = parser.parse_args()
    print(json.dumps(drain("POST" if args.action == "acquire" else "DELETE")))
