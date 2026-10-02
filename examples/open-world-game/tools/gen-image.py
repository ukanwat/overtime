#!/usr/bin/env python3
"""Generate an image on-device — for signage, billboards, posters, murals, packaging,
portraits, anything printed that a city is covered in. No API key, no network cost.

    python3 gen-image.py "worn 1970s motel sign, script neon lettering" -o sign.png
    python3 gen-image.py "<prompt>" -o out.png --w 1024 --h 512 --steps 4 --seed 12

Runs the venv interpreter at $IMG_VENV (default ~/imagegen), so it works regardless of which
python3 you invoke it with. First run downloads weights (a few GB) and is slow; later runs are
seconds. Model is SDXL-Turbo — ungated, no login.

Invent your own brands. Never reproduce a real company's mark, logo, slogan or livery, and
never anything from an existing game.
"""
import argparse, os, subprocess, sys, textwrap
from pathlib import Path

VENV = Path(os.environ.get("IMG_VENV", Path.home() / "imagegen"))
MODEL = os.environ.get("IMG_MODEL", "stabilityai/sdxl-turbo")

WORKER = textwrap.dedent('''
    import sys, torch
    from diffusers import AutoPipelineForText2Image
    prompt, out, w, h, steps, seed, model = sys.argv[1:8]
    w, h, steps, seed = int(w), int(h), int(steps), int(seed)
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    pipe = AutoPipelineForText2Image.from_pretrained(
        model, torch_dtype=torch.float16, variant="fp16")
    pipe = pipe.to(dev)
    pipe.set_progress_bar_config(disable=True)
    g = torch.Generator(device="cpu").manual_seed(seed)
    img = pipe(prompt=prompt, num_inference_steps=steps, guidance_scale=0.0,
               width=w, height=h, generator=g).images[0]
    img.save(out)
    print(out)
''')


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("prompt")
    ap.add_argument("-o", "--output", default="image.png")
    ap.add_argument("--w", type=int, default=1024)
    ap.add_argument("--h", type=int, default=512)
    ap.add_argument("--steps", type=int, default=4, help="SDXL-Turbo needs very few; 1-8")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()

    py = VENV / "bin" / "python"
    if not py.exists():
        sys.exit(f"no image venv at {VENV} — run ./setup-capabilities.sh first")

    r = subprocess.run(
        [str(py), "-c", WORKER, a.prompt, a.output,
         str(a.w), str(a.h), str(a.steps), str(a.seed), MODEL],
        text=True, capture_output=True)
    if r.returncode != 0:
        sys.stderr.write(r.stderr[-2000:])
        return r.returncode
    print(r.stdout.strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
