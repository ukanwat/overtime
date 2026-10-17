"""Makes the files the scripted demos' agents "made": charts (PNG, plus a .ansi twin the demo's
in-terminal viewer can show, since a recording can't capture terminal images) and the CV as a PDF.
Made-up data throughout. Needs matplotlib and Pillow; the PDF needs Google Chrome.

    python3 docs/demos/files.py
"""
import os
import subprocess
import tempfile

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from PIL import Image  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
BG, FG, MUTED, GRID = "#1a1b26", "#c0caf5", "#565f89", "#292e42"
RED, BLUE, GREEN, YELLOW = "#f7768e", "#7aa2f7", "#9ece6a", "#e0af68"


def style(ax, fig):
    fig.patch.set_facecolor(BG)
    ax.set_facecolor(BG)
    for s in ax.spines.values():
        s.set_visible(False)
    ax.tick_params(colors=MUTED, labelsize=11)
    ax.grid(axis="y", color=GRID, linewidth=1)
    ax.set_axisbelow(True)


def ansi(fig, ax, out, cols, title, caption):
    """The chart in half-blocks: each character is two pixels, top in its colour, bottom behind it. Text
    doesn't survive at that size, so it's drawn without any; the title and caption say it instead."""
    for t in list(ax.texts):
        t.remove()
    ax.set_xticklabels([])
    ax.set_yticklabels([])
    ax.set_ylabel("")
    ax.tick_params(length=0)
    # Thin dashed markers vanish in half-blocks: draw them solid and wide.
    for line in ax.lines:
        if len(set(line.get_xdata())) == 1:
            line.set_linestyle("-")
            line.set_linewidth(7)
    png = out[:-5] + ".tmp.png"
    fig.savefig(png, facecolor=BG)
    img = Image.open(png).convert("RGB")
    os.unlink(png)
    rows = round(img.height / img.width * cols / 2) * 2
    img = img.resize((cols, rows), Image.LANCZOS)
    px = img.load()
    lines = ["\x1b[1m" + title + "\x1b[22m", ""]
    for y in range(0, rows, 2):
        cells = []
        for x in range(cols):
            (r1, g1, b1), (r2, g2, b2) = px[x, y], px[x, y + 1]
            cells.append(f"\x1b[38;2;{r1};{g1};{b1}m\x1b[48;2;{r2};{g2};{b2}m▀")
        lines.append("".join(cells) + "\x1b[0m")
    lines += [""] + ["\x1b[2m" + c + "\x1b[22m" for c in caption]
    with open(out, "w") as f:
        f.write("\n".join(lines) + "\n")


def canary():
    mins = list(range(0, 31))
    rate = [0.02] * 3 + [0.4, 2.1, 4.2, 3.9, 0.9, 0.2] + [0.02] * 22
    fig, ax = plt.subplots(figsize=(11, 3.6), dpi=100)
    style(ax, fig)
    ax.fill_between(mins, rate, color=RED, alpha=0.25)
    ax.plot(mins, rate, color=RED, linewidth=4)
    ax.axvline(6.5, color=YELLOW, linewidth=2, linestyle="--")
    ax.text(7, 3.6, "rolled back", color=YELLOW, fontsize=13)
    ax.axvline(18, color=GREEN, linewidth=2, linestyle="--")
    ax.text(18.5, 3.6, "#485 hotfix", color=GREEN, fontsize=13)
    ax.set_ylabel("5xx %", color=MUTED, fontsize=12)
    ax.set_xlim(0, 30)
    ax.set_ylim(0, 4.6)
    fig.tight_layout()
    p = os.path.join(HERE, "team/files/canary-5xx.png")
    fig.savefig(p, facecolor=BG)
    ansi(fig, ax, p[:-4] + ".ansi", 112, "5xx rate on /v2/billing/export, canary (10%), 14:11–14:41",
         ["red: 5xx %, peak 4.2% at 14:16 · yellow: rolled back, 14:17 · green: hotfix #485 live, 14:29"])


def budget():
    cats = ["Rent", "Groceries", "Eating out", "Transport", "Subscriptions", "Fun", "Saved"]
    plan = [2400, 520, 300, 180, 90, 250, 1500]
    real = [2400, 471, 342, 126, 137, 198, 1912]
    fig, ax = plt.subplots(figsize=(11, 3.8), dpi=100)
    style(ax, fig)
    x = range(len(cats))
    ax.bar([i - 0.2 for i in x], plan, width=0.4, color=MUTED, label="planned")
    colors = [RED if r > p and c != "Saved" else (GREEN if c == "Saved" else BLUE) for c, p, r in zip(cats, plan, real)]
    ax.bar([i + 0.2 for i in x], real, width=0.4, color=colors, label="spent")
    ax.set_xticks(list(x))
    ax.set_xticklabels(cats, color=FG, fontsize=12)
    fig.tight_layout()
    p = os.path.join(HERE, "life/files/budget-october.png")
    fig.savefig(p, facecolor=BG)
    ansi(fig, ax, p[:-4] + ".ansi", 112, "October: planned (grey) vs spent; saved $1,912, $412 more than planned",
         ["Rent · Groceries · Eating out (+$42) · Transport · Subscriptions (+$47: 3 unused) · Fun · Saved",
          "Unused: Peloton app $24, StreamPlus $15, cloud storage tier 2 $8 · cancel all three: $564 a year"])


def cv_pdf():
    chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    if not os.path.exists(chrome):
        print("skipping the CV PDF: no Google Chrome")
        return
    md = open(os.path.join(HERE, "life/files/sam-cv-stripe.md")).read()
    html = []
    for line in md.splitlines():
        line = line.replace("**", "\x00")
        while "\x00" in line:
            line = line.replace("\x00", "<b>", 1).replace("\x00", "</b>", 1)
        if line.startswith("# "):
            html.append(f"<h1>{line[2:]}</h1>")
        elif line.startswith("## "):
            html.append(f"<h2>{line[3:]}</h2>")
        elif line.startswith("- "):
            html.append(f"<li>{line[2:]}</li>")
        elif line.strip():
            html.append(f"<p>{line}</p>")
    css = "body{font:11pt -apple-system,Helvetica;margin:48px;color:#1b1b1f}h1{margin:0;font-size:22pt}h2{border-bottom:1px solid #ccc;font-size:12pt;text-transform:uppercase;letter-spacing:.06em;margin-top:22px}li{margin:4px 0}"
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
        f.write(f"<html><head><meta charset=utf-8><style>{css}</style></head><body>{''.join(html)}</body></html>")
    out = os.path.join(HERE, "life/files/sam-cv-stripe.pdf")
    subprocess.run([chrome, "--headless", "--no-sandbox", f"--user-data-dir={tempfile.mkdtemp()}", "--disable-gpu", "--no-pdf-header-footer", f"--print-to-pdf={out}", f.name], check=True, capture_output=True)
    os.unlink(f.name)


canary()
budget()
cv_pdf()
print("made the demo files")
