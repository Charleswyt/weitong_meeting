"""Add common-room presence to the existing authenticated ROI and recording operations feed."""
from pathlib import Path
import argparse


def patched(text):
    old = '        return {"sampledAt": wall, "rooms": rooms, "maintenanceUntil": self.maintenance_until()}'
    if 'WEITONG_OCEAN_PRESENCE_URL' in text:
        return text
    if text.count(old) != 1:
        raise ValueError('unrecognized Sinosat presence adapter')
    return text.replace(old, '''        import os
        import urllib.request
        target = os.getenv("WEITONG_OCEAN_PRESENCE_URL")
        if target:
            # This exact loopback service is allowed to receive the operations credential.
            if target != "http://127.0.0.1:8092/internal/weitong/rooms":
                raise RuntimeError("invalid native operations endpoint")
            req = urllib.request.Request(target, headers={"Authorization":"Bearer "+self.cfg["weitongBridgeToken"]})
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(req, timeout=4) as response:
                other = json.load(response)
            if abs(time.time()-other["sampledAt"]) >= 10 or rooms.keys() & other["rooms"].keys():
                raise RuntimeError("common room activity is stale or ambiguous")
            rooms.update(other["rooms"])
''' + old)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('source', type=Path)
    p.add_argument('output', type=Path)
    a = p.parse_args()
    text = patched(a.source.read_text())
    compile(text, str(a.source), 'exec')
    a.output.write_text(text)
