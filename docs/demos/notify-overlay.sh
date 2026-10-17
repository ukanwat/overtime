#!/usr/bin/env bash
# Draws the notifications Overtime would have sent onto a scripted demo's video, and makes its GIF.
# A recording only sees the terminal; on a Mac the banners pop in the screen's corner. The scripted demos
# (team, life) log each one (who, what, when) to /tmp/ot-demo-<name>/notifications.jsonl; this renders
# each as a macOS banner and slides it in at the top right for a few seconds.
#
#   docs/demos/notify-overlay.sh team                  the raw take → team.gif and team.mp4, with its banners
#   docs/demos/notify-overlay.sh life --light          light banners
#   docs/demos/notify-overlay.sh team --app-name Overtime --icon path/to/icon.png
#
# By default the banner is what Overtime really shows today: it notifies through `osascript`, so macOS
# draws it with Script Editor's icon and no app name, titled "<agent> has a question" for a question, or
# the agent's name with the report's title under it. --app-name and --icon change that if Overtime ever
# notifies as itself. Needs ffmpeg, and Google Chrome to draw the banners.

set -euo pipefail
DEMOS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="${1:?which demo? e.g. team}"
shift
APP=""
ICON=""
THEME=dark
while [ $# -gt 0 ]; do
  case "$1" in
    --app-name) APP="$2"; shift 2 ;;
    --icon) ICON="$2"; shift 2 ;;
    --light) THEME=light; shift ;;
    *) echo "✗ Unknown option $1" >&2; exit 1 ;;
  esac
done
LOG="/tmp/ot-demo-$NAME/notifications.jsonl"
# The tape records a GIF to the scratch folder (lossless frames, unlike its mp4, so the finished GIF stays
# small); the finished GIF and an mp4 to check it by go next to the other demos'.
RAW="/tmp/ot-demo-$NAME/$NAME.gif"
MP4="$DEMOS/$NAME.mp4"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -f "$RAW" ] || { echo "✗ No $RAW: record it first (vhs $NAME/$NAME.tape)." >&2; exit 1; }
[ -f "$LOG" ] || { echo "✗ No $LOG: the demo logs its notifications there while it's recorded." >&2; exit 1; }
[ -x "$CHROME" ] || { echo "✗ Google Chrome draws the banners and isn't in /Applications." >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if [ -z "$ICON" ]; then
  ICON="$WORK/icon.png"
  sips -s format png -Z 128 "/System/Applications/Utilities/Script Editor.app/Contents/Resources/AppIcon.icns" --out "$ICON" >/dev/null
fi

# One PNG per banner, drawn by Chrome from HTML at 2x and shown at half size, so the text is crisp. Headless
# Chrome's page is shorter than its window, so the window is tall and the banner is cropped from its top.
node - "$LOG" "$WORK" "$ICON" "$APP" "$THEME" <<'EOF'
const fs = require("fs"), path = require("path");
const [log, work, icon, app, theme] = process.argv.slice(2);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const dark = theme === "dark";
const icon64 = fs.readFileSync(icon).toString("base64");
const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
lines.forEach((n, i) => {
  const html = `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; background: transparent; }
    body { padding: 14px 20px 26px; font-family: -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif; -webkit-font-smoothing: antialiased; }
    .card { width: 344px; box-sizing: border-box; display: flex; gap: 10px; padding: 11px 14px 11px 11px; border-radius: 16px;
      background: ${dark ? "rgba(44,44,48,0.94)" : "rgba(246,246,246,0.96)"}; border: 0.5px solid ${dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.10)"};
      box-shadow: 0 8px 24px rgba(0,0,0,${dark ? 0.45 : 0.22}), 0 0 1px rgba(0,0,0,0.3); color: ${dark ? "#fff" : "#1d1d1f"}; }
    img { width: 38px; height: 38px; flex: none; margin-top: 1px; }
    .text { flex: 1; min-width: 0; font-size: 13px; line-height: 16px; }
    .top { display: flex; justify-content: space-between; gap: 8px; }
    .app { font-size: 11px; line-height: 14px; opacity: 0.55; text-transform: uppercase; letter-spacing: 0.02em; }
    .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .now { font-size: 12px; opacity: 0.5; flex: none; }
    .body { opacity: 0.88; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  </style><div class="card"><img src="data:image/png;base64,${icon64}"><div class="text">
    ${app ? `<div class="app">${esc(app)}</div>` : ""}<div class="top"><div class="title">${esc(n.title)}</div><div class="now">now</div></div>
    <div class="body">${esc(n.body)}</div></div></div>`;
  fs.writeFileSync(path.join(work, `b${i}.html`), html);
  fs.writeFileSync(path.join(work, `b${i}.t`), String(n.t));
});
EOF

i=0
while [ -f "$WORK/b$i.html" ]; do
  "$CHROME" --headless --no-sandbox --user-data-dir="$WORK/chrome" --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --default-background-color=00000000 --window-size=390,400 --screenshot="$WORK/b$i.png" "file://$WORK/b$i.html" >/dev/null 2>&1
  i=$((i + 1))
done
N=$i
echo "◆ $NAME: $N notification(s) onto the video"

# Each banner slides in from the right edge, stays about 3.5 s, and fades out, as macOS does.
HOLD=3.6
inputs=()
filter=""
last="0:v"
for ((i = 0; i < N; i++)); do
  t=$(cat "$WORK/b$i.t")
  inputs+=(-loop 1 -framerate 24 -t "$HOLD" -i "$WORK/b$i.png")
  filter+="[$((i + 1)):v]crop=iw:250:0:0,scale=iw/2:-1,format=rgba,fade=out:st=$(awk -v h=$HOLD 'BEGIN{print h-0.4}'):d=0.4:alpha=1,setpts=PTS+$t/TB[b$i];"
  # x: from just past the right edge to its place, easing out over 0.35 s.
  filter+="[$last][b$i]overlay=x='main_w-overlay_w+4+(overlay_w)*pow(max(0,1-(t-$t)/0.35),3)':y=6:enable='between(t,$t,$t+$HOLD)':eof_action=pass[v$i];"
  last="v$i"
done
if [ "$N" -gt 0 ]; then
  ffmpeg -v error -y -i "$RAW" "${inputs[@]}" -filter_complex "${filter%;}" -map "[$last]" -c:v ffv1 "$WORK/take.mkv"
else
  ffmpeg -v error -y -i "$RAW" -c:v ffv1 "$WORK/take.mkv"
fi
ffmpeg -v error -y -i "$WORK/take.mkv" -c:v libx264 -pix_fmt yuv420p -crf 18 "$MP4"

# The GIF from the video: one palette for the whole take, no dithering, so text stays sharp.
ffmpeg -v error -y -i "$WORK/take.mkv" -vf "fps=12,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" "$DEMOS/$NAME.gif"
echo "✓ $NAME.gif ($(du -h "$DEMOS/$NAME.gif" | cut -f1))"
