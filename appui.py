#!/usr/bin/env python3
"""Drive a desktop application window when a task needs its GUI.

Scoped to ONE application's window on purpose: it captures only that window's rectangle, never
the whole screen and never anything else you have open. Coordinates you pass are relative to the
window's top-left, so they stay valid if the window moves.

    python3 appui.py apps                          # which GUI apps are running
    python3 appui.py bounds  "Epic Games Launcher"
    python3 appui.py shot    "Epic Games Launcher" /tmp/ui.png     # then Read the PNG
    python3 appui.py click   "Epic Games Launcher" 420 260
    python3 appui.py move    "Epic Games Launcher" 420 260         # hover, no click
    python3 appui.py dblclick "Epic Games Launcher" 420 260
    python3 appui.py type    "Epic Games Launcher" "game animation sample"
    python3 appui.py key     "Epic Games Launcher" return          # return/tab/esc/space/arrows
    python3 appui.py scroll  "Epic Games Launcher" -5 [x y]        # negative = down; x,y scrolls under that point
    python3 appui.py combo   "Epic Games Launcher" cmd a           # modifier chord
    python3 appui.py front   "Epic Games Launcher"

Workflow that actually works: shot → Read the image → decide → click → shot again to confirm.
Never click blind; a GUI you cannot see is a GUI you are guessing at.

FOCUS: `shot` never raises the window and never takes focus — it captures the window's own
buffer, even when it is behind something else, so you can watch an app all you like while
someone else is using the machine. `click`/`type`/`key` must briefly raise the target (the app
has no accessibility tree, so there is nothing to click but pixels) and then hand focus straight
back to whatever had it. Keep those bursts short and batch them.

macOS will ask once for Screen Recording (for the capture) and Accessibility (for the clicks).
If a command silently does nothing, that permission is the reason.
"""
import subprocess
import sys
import time

# The process name is not always the menu-bar name; map the ones that differ.
ALIASES = {
    "epic games launcher": "EpicGamesLauncher-Mac-Shipping",
    "epic": "EpicGamesLauncher-Mac-Shipping",
    "unreal": "UnrealEditor",
}


def window_id(app: str):
    """CGWindow id of the app's largest on-screen window — lets us capture it WITHOUT
    raising it, so observing costs the user no focus."""
    import re
    import Quartz

    def key(s):  # "Epic Games Launcher" and "EpicGamesLauncher-Mac-Shipping" must match
        return re.sub(r"[^a-z0-9]", "", (s or "").lower()).replace("macshipping", "")

    want = key(proc_name(app)) or key(app)
    wl = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID)
    best, area = None, 0
    for w in wl:
        owner = key(w.get("kCGWindowOwnerName"))
        if not owner or (want not in owner and owner not in want):
            continue
        b = w.get("kCGWindowBounds") or {}
        a = b.get("Width", 0) * b.get("Height", 0)
        if a > area:
            best, area = w, a
    return (best.get("kCGWindowNumber"), best.get("kCGWindowBounds")) if best else (None, None)


def frontmost() -> str:
    return osa('tell application "System Events" to get name of first process '
               'whose frontmost is true')


def osa(script: str) -> str:
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(f"applescript failed: {r.stderr.strip()[:200]}")
    return r.stdout.strip()


def proc_name(app: str) -> str:
    return ALIASES.get(app.strip().lower(), app)


def scroll(lines: int, steps: int = 6):
    """Scroll wheel via Quartz. Negative = down (content moves up), like a real wheel.

    Sent in several small events rather than one big one because most Mac apps treat a
    single large delta as a flick and animate past where you wanted to be.
    Needs `pyobjc-framework-Quartz` (pip install pyobjc-framework-Quartz).
    """
    import Quartz
    per = max(1, abs(lines) // steps) * (1 if lines > 0 else -1)
    sent = 0
    while abs(sent) < abs(lines):
        d = per if abs(lines) - abs(sent) >= abs(per) else lines - sent
        ev = Quartz.CGEventCreateScrollWheelEvent(
            None, Quartz.kCGScrollEventUnitLine, 1, int(d))
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)
        sent += d
        time.sleep(0.02)


def bounds(app: str):
    p = proc_name(app)
    out = osa(f'tell application "System Events" to tell process "{p}" '
              'to get {position, size} of window 1')
    nums = [int(float(x)) for x in out.replace(",", " ").split()]
    if len(nums) != 4:
        raise SystemExit(f"unexpected bounds for {p}: {out}")
    return nums  # x, y, w, h


def front(app: str):
    p = proc_name(app)
    osa(f'tell application "System Events" to set frontmost of process "{p}" to true')
    time.sleep(0.6)


def shot(app: str, path: str):
    """Capture the window without raising it — no focus stolen, works even if occluded."""
    wid, b = window_id(app)
    if wid:
        subprocess.run(["screencapture", "-x", "-o", f"-l{wid}", path], check=True)
        print(f"{path}  (window id {wid}, {int(b.get('Width',0))}x{int(b.get('Height',0))}, no focus taken)")
    else:
        x, y, w, h = bounds(app)
        subprocess.run(["screencapture", "-x", "-o", f"-R{x},{y},{w},{h}", path], check=True)
        print(f"{path}  (region {w}x{h} at {x},{y})")


def _abs(app: str, wx: int, wy: int):
    x, y, w, h = bounds(app)
    if not (0 <= wx <= w and 0 <= wy <= h):
        raise SystemExit(f"({wx},{wy}) is outside the {w}x{h} window — coordinates are "
                         "relative to the window's top-left")
    return x + wx, y + wy


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    cmd = sys.argv[1]

    if cmd == "apps":
        out = osa('tell application "System Events" to get name of every process '
                  'whose background only is false')
        print("\n".join(sorted(s.strip() for s in out.split(","))))
        return 0

    app = sys.argv[2]

    if cmd == "bounds":
        x, y, w, h = bounds(app)
        print(f"x={x} y={y} w={w} h={h}")
    elif cmd == "front":
        front(app)
        print("frontmost")
    elif cmd == "shot":
        shot(app, sys.argv[3] if len(sys.argv) > 3 else "/tmp/appui.png")
    elif cmd in ("click", "dblclick", "move"):
        was = frontmost()
        front(app)
        ax, ay = _abs(app, int(sys.argv[3]), int(sys.argv[4]))
        verb = {"click": "c", "dblclick": "dc", "move": "m"}[cmd]
        subprocess.run(["cliclick", f"{verb}:{ax},{ay}"], check=True)
        if was and was != proc_name(app):
            time.sleep(0.4)
            try: osa(f'tell application "System Events" to set frontmost of process "{was}" to true')
            except SystemExit: pass
        print(f"{cmd} at window({sys.argv[3]},{sys.argv[4]}) = screen({ax},{ay})"
              + (f"; focus returned to {was}" if was else ""))
    elif cmd == "type":
        front(app)
        subprocess.run(["cliclick", "-w", "40", f"t:{sys.argv[3]}"], check=True)
        print("typed")
    elif cmd == "key":
        front(app)
        subprocess.run(["cliclick", f"kp:{sys.argv[3]}"], check=True)
        print(f"key {sys.argv[3]}")
    elif cmd == "scroll":
        # cliclick has NO scroll command -- `sc:` was never valid and this silently
        # failed every time it was called. Scroll wheel events come from Quartz.
        # Optional x,y: scroll where the pointer is, which for a panelled UI like the
        # Fab store is the only way to scroll the panel rather than the page behind it.
        front(app)
        lines = int(sys.argv[3])
        if len(sys.argv) > 5:
            ax, ay = _abs(app, int(sys.argv[4]), int(sys.argv[5]))
            subprocess.run(["cliclick", f"m:{ax},{ay}"], check=True)
        scroll(lines)
        print(f"scrolled {lines} line(s)")
    elif cmd == "combo":
        # A modifier chord, e.g. `combo "App" cmd a` for select-all. cliclick's kp:
        # only accepts a fixed list of named keys, so a letter has to be typed with
        # the modifier held down around it.
        front(app)
        mods, key = sys.argv[3], sys.argv[4]
        subprocess.run(["cliclick", f"kd:{mods}", f"t:{key}", f"ku:{mods}"], check=True)
        print(f"combo {mods}+{key}")
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
