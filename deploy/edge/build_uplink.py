"""Build the board's WAN publisher from the Ocean media SDK supplied with the board image."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="Ocean tools/h264_whip_publisher directory")
    parser.add_argument("output", type=Path)
    parser.add_argument("--go", default="go")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "publisher"
        shutil.copytree(args.source, src, ignore=shutil.ignore_patterns(".git"))
        main_go = src / "main.go"
        text = main_go.read_text()
        old = "settingEngine.SetInterfaceFilter(allowLoopbackInterface)"
        # The local H264 capture still uses the SDK's loopback interface. Only the
        # outgoing media publisher should use the physical route to the meeting server.
        anchor = 'iceNetwork := flag.String("ice-network",'
        if text.count(anchor) != 1 or text.count(old) != 1:
            raise SystemExit("Ocean publisher source changed; verify its ICE interface selection")
        text = text.replace(anchor, 'outInterface := flag.String("uplink-interface", "", "physical uplink for remote WHIP")\n\t' + anchor)
        text = text.replace(old, '''if *outInterface == "" {
        settingEngine.SetInterfaceFilter(allowLoopbackInterface)
    } else {
        settingEngine.SetInterfaceFilter(func(name string) bool { return name == *outInterface })
    }''')
        capture = 'if *rtspCapture != "" {'
        if text.count(capture) != 1:
            raise SystemExit("Ocean capture option changed")
        text = text.replace(capture, 'if *rtspCapture == "env:WEITONG_WHEP" { *rtspCapture = os.Getenv("WEITONG_WHEP") }\n\t' + capture)
        main_go.write_text(text)
        # Only the HTTPS reader needs AVC configuration records. Local RK input keeps its original framing.
        capture_go = src / "zha_capture.go"
        recording = capture_go.read_text()
        edits = {
            "type captureUnit struct {": "type captureUnit struct {\n\tconfig []byte",
            "queue := make(chan captureUnit, 256)": 'webReader := os.Getenv("WEITONG_WHEP") != ""\n\tvar config browserAVCConfig\n\tqueue := make(chan captureUnit, 256)',
            "unit, _ := normalizeH264AccessUnit": "var parameters []byte\n\t\t\tif webReader { parameters = config.keyframeConfig(nalus) }\n\t\t\tunit, _ := normalizeH264AccessUnit",
            "captureUnit{unit, packet.Timestamp, ntp}": "captureUnit{unit: unit, rtpTimestamp: packet.Timestamp, ntp: ntp, config: parameters}",
            "current.unit.ptsDelta = uint32(delta)": """if len(current.config) > 0 {
                    if err = write(encodeAccessUnit(accessUnit{payload: current.config, flags: flagConfig})); err != nil { return err }
                }
                current.unit.ptsDelta = uint32(delta)""",
        }
        for old, new in edits.items():
            if recording.count(old) != 1:
                raise SystemExit("Ocean capture framing changed; review the WebCodecs reader adapter")
            recording = recording.replace(old, new)
        capture_go.write_text(recording)
        for file in Path(__file__).with_name("reader").glob("*.go"):
            shutil.copyfile(file, src / file.name)
        env = dict(os.environ, CGO_ENABLED="0")
        subprocess.run([args.go, "test", "./..."], cwd=src, env=env, check=True)
        subprocess.run([args.go, "build", "-trimpath", "-ldflags=-s -w", "-o", str(args.output.resolve()), "."], cwd=src, env=env, check=True)


if __name__ == "__main__":
    main()
