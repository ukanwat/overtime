#!/usr/bin/env python3
"""Viewport-capture helper for the UE agent loop.

The MCP CaptureViewport tool returns a base64 PNG inline — huge, and it floods
the agent's context. This decodes it to a file the agent can Read instead.

  # from a file containing base64 (or a JSON blob with a base64 field):
  python3 ue_qa.py decode raw.txt scene
  # from stdin:
  ... | python3 ue_qa.py decode - scene
  # compare two shots (needs ImageMagick for the visual diff):
  python3 ue_qa.py diff /tmp/ue_qa/before.png /tmp/ue_qa/after.png

Output goes to /tmp/ue_qa/<name>.png and prints the path + basic stats.
"""
import base64
import json
import os
import re
import subprocess
import sys

OUT = "/tmp/ue_qa"


def _extract_b64(text: str) -> str:
    text = text.strip()
    # JSON payload? find the longest string value that looks like base64 PNG.
    if text.startswith("{") or text.startswith("["):
        try:
            blob = json.loads(text)
            cands = []

            def walk(o):
                if isinstance(o, str):
                    cands.append(o)
                elif isinstance(o, dict):
                    for v in o.values():
                        walk(v)
                elif isinstance(o, list):
                    for v in o:
                        walk(v)

            walk(blob)
            cands = [c for c in cands if len(c) > 512]
            if cands:
                text = max(cands, key=len)
        except json.JSONDecodeError:
            pass
    # strip data-URL prefix and whitespace
    text = re.sub(r"^data:image/\w+;base64,", "", text.strip())
    return re.sub(r"\s+", "", text)


def decode(src: str, name: str) -> None:
    raw = sys.stdin.read() if src == "-" else open(src, encoding="utf-8", errors="ignore").read()
    b64 = _extract_b64(raw)
    if not b64:
        sys.exit("no base64 payload found")
    data = base64.b64decode(b64 + "=" * (-len(b64) % 4))
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f"{name}.png")
    with open(path, "wb") as fh:
        fh.write(data)
    kind = "PNG" if data[:4] == b"\x89PNG" else "unknown format"
    print(f"{path}  ({len(data)/1024:.0f} KB, {kind})")
    print("Read this file to SEE the viewport. Judge it like a stranger would.")


def diff(a: str, b: str) -> None:
    out = os.path.join(OUT, "diff.png")
    try:
        r = subprocess.run(
            ["magick", "compare", "-metric", "RMSE", a, b, out],
            capture_output=True, text=True,
        )
        print(f"RMSE: {r.stderr.strip()}  ->  {out}")
    except FileNotFoundError:
        sa, sb = os.path.getsize(a), os.path.getsize(b)
        print(f"ImageMagick not installed (brew install imagemagick).")
        print(f"byte sizes: {sa} vs {sb} (delta {sb - sa:+d})")


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "decode":
        decode(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "shot")
    elif len(sys.argv) == 4 and sys.argv[1] == "diff":
        diff(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)
