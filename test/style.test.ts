import { describe, it, expect, afterEach, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { applyTerminalColors, cut, resetPalette, STATE_TURN, stateGlyph, stateWord, statusLine, statusParts, when } from "../src/tui/style.js";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("the agent's state circle", () => {
  const base = { status: "asleep", activity: "", nextWake: null, pausedUntil: null, lastError: null, waiting: 0 };
  const states: [string, any, string | null][] = [
    ["working", { status: "working" }, null],
    ["waiting for you", { waiting: 1 }, "●"],
    ["retrying", { lastError: "boom" }, "⊘"],
    ["can't reach its backend", { trouble: { since: "", backend: "claude" }, helpersRunning: 1 }, "⊘"],
    ["asleep", {}, "○"],
    ["paused", { status: "paused" }, "◌"],
    ["stopped", { status: "stopped" }, "⊖"],
    ["new", { status: "new" }, "◦"],
  ];
  const dark = () => applyTerminalColors({ background: { r: 12, g: 12, b: 12 }, foreground: { r: 224, g: 224, b: 224 } }, true);
  afterEach(() => {
    resetPalette();
    process.env.OVERTIME_STILL = "1";
  });

  it("is a circle for every state, differing by shape, one column wide in every frame", () => {
    delete process.env.OVERTIME_STILL;
    dark();
    const shapes = new Map<string, Set<string>>();
    for (const [name, o, mark] of states) {
      const seen = new Set<string>();
      for (let t = 0; t < 6000; t += 50) {
        const g = plain(stateGlyph({ ...base, ...o }, t).glyph);
        expect(visibleWidth(g)).toBe(1);
        expect("●○◌◦⊘⊖◐◓◑◒").toContain(g);
        seen.add(g);
      }
      if (mark) expect([...seen]).toEqual([mark]);
      shapes.set(name, seen);
    }
    expect([...shapes.get("working")!]).toEqual(STATE_TURN);
    // No two states share a shape (the two failures are one state), and no still circle is a frame of the turning one.
    const all = [...shapes.entries()].filter(([n]) => n !== "can't reach its backend").flatMap(([, v]) => [...v]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("turns calmly while working, pulses yellow for you, and stays still while asleep", () => {
    delete process.env.OVERTIME_STILL;
    dark();
    const frames = (o: any, from: number, to: number, step: number) => Array.from({ length: (to - from) / step }, (_, i) => stateGlyph({ ...base, ...o }, from + i * step).glyph);
    // Working: a quarter turn every 200 ms, the same four frames each 800 ms.
    expect(stateGlyph({ ...base, status: "working" }).period).toBe(200);
    expect(new Set(frames({ status: "working" }, 0, 800, 200)).size).toBe(4);
    expect(frames({ status: "working" }, 800, 1600, 100)).toEqual(frames({ status: "working" }, 0, 800, 100));
    // Needs you: a 1.6 s pulse in shades of yellow, the same full circle throughout.
    expect(stateGlyph({ ...base, waiting: 1 }).period).toBe(100);
    const w = frames({ waiting: 1 }, 0, 1600, 100);
    expect(new Set(w).size).toBeGreaterThan(5);
    expect(frames({ waiting: 1 }, 1600, 3200, 100)).toEqual(w);
    // Asleep: a still, dim circle, the same at every moment.
    expect(stateGlyph(base).period).toBe(null);
    expect(new Set(frames({}, 0, 2800, 100)).size).toBe(1);
    // Still states don't ask for frames.
    for (const o of [{}, { lastError: "x" }, { status: "paused" }, { status: "stopped" }, { status: "new" }]) expect(stateGlyph({ ...base, ...o }).period).toBe(null);
  });

  it("means one thing per circle: the word next to it always agrees", () => {
    const wake = new Date(Date.now() + 3 * 3600_000).toISOString();
    const lines: [any, RegExp, RegExp][] = [
      [{ status: "working" }, /^◐ working$/, /^working$/],
      [{ status: "working", helpersRunning: 2 }, /^◐ working · 2 helpers$/, /^working$/],
      [{ helpersRunning: 1 }, /^◐ working · 1 helper$/, /^working$/],
      [{ waiting: 1 }, /^● needs you$/, /^needs you$/],
      [{ waiting: 1, nextWake: wake }, /^● needs you · wakes /, /^needs you$/],
      [{ waiting: 1, status: "paused" }, /^● needs you$/, /^needs you$/],
      [{ lastError: "boom", nextWake: wake }, /^⊘ retrying (at|tomorrow) /, /^retrying$/],
      [{ lastError: "boom" }, /^⊘ retrying$/, /^retrying$/],
      [{ lastError: "boom", waiting: 1 }, /^⊘ retrying$/, /^retrying$/],
      [{ trouble: { since: "", backend: "claude" }, helpersRunning: 1 }, /^⊘ can't reach claude$/, /^can't reach$/],
      // Waiting for its backend to be signed in (it carries on by itself): said as that, not as a failed turn.
      [{ trouble: { since: "", backend: "claude", signIn: true }, lastError: "claude: Authentication required", nextWake: wake }, /^⊘ claude isn't signed in$/, /^not signed in$/],
      [{ trouble: { since: "", backend: "claude", signIn: true }, helpersRunning: 1 }, /^⊘ claude isn't signed in$/, /^not signed in$/],
      [{ offlineSince: "x", status: "working" }, /^⊘ no internet$/, /^offline$/],
      [{ nextWake: wake }, /^○ asleep · wakes /, /^(\d+:\d\d|\w{3})/],
      [{}, /^○ asleep$/, /^asleep$/],
      [{ status: "paused", pauseReason: "budget" }, /^◌ paused · budget used$/, /^paused$/],
      [{ status: "stopped" }, /^⊖ stopped$/, /^stopped$/],
      [{ status: "new" }, /^◦ new · waiting for its job$/, /^new$/],
    ];
    for (const [o, line, word] of lines) {
      expect(plain(statusLine({ ...base, ...o }))).toMatch(line);
      expect(plain(stateWord({ ...base, ...o }))).toMatch(word);
    }
  });

  it("says when an asleep agent wakes in the list's word: a time today, a weekday this week, a date further out", () => {
    const at = (days: number, hour = 15) => {
      const d = new Date();
      d.setDate(d.getDate() + days);
      d.setHours(hour, 0, 0, 0);
      return d.toISOString();
    };
    expect(plain(stateWord({ ...base, nextWake: at(0, 23) }))).toMatch(/^\d+:\d\d(pm|am)?$|^\d\d:\d\d$/);
    expect(plain(stateWord({ ...base, nextWake: at(3) }))).toMatch(/^[A-Z][a-z]{2}$/);
    expect(plain(stateWord({ ...base, nextWake: at(10) }))).toMatch(/\d/);
  });

  it("holds still for tests, without true colour, and with NO_COLOR", () => {
    process.env.OVERTIME_STILL = "1";
    dark();
    for (const [, o] of states) {
      expect(stateGlyph({ ...base, ...o }, 0)).toEqual(stateGlyph({ ...base, ...o }, 1234));
      expect(stateGlyph({ ...base, ...o }).period).toBe(null);
    }
    delete process.env.OVERTIME_STILL;
    resetPalette();
    expect(stateGlyph(base).period).toBe(null);
    expect(stateGlyph({ ...base, waiting: 1 }).period).toBe(null);
    process.env.NO_COLOR = "1";
    try {
      expect(stateGlyph({ ...base, waiting: 1 }).glyph).toBe("●");
    } finally {
      delete process.env.NO_COLOR;
    }
  });
});

describe("plain text", () => {
  it("cuts plain text to width with an ellipsis and no escape codes", () => {
    expect(cut("lighting the harbour district", 12)).toBe("lighting th…");
    expect(cut("short", 12)).toBe("short");
  });
});

describe("links in messages", () => {
  it("become clickable where they're written, longest first, with your home shown as ~", async () => {
    const { linkify } = await import("../src/tui/app.js");
    const text = "See /Users/me/a/story and /Users/me/a/story/review.md, or https://example.com/x.";
    const out = linkify(text, [
      { label: "/Users/me/a/story", target: "/Users/me/a/story", kind: "folder" },
      { label: "/Users/me/a/story/review.md", target: "/Users/me/a/story/review.md", kind: "file" },
      { label: "https://example.com/x", target: "https://example.com/x", kind: "url" },
    ], "/Users/me");
    const visible = out.replace(/\x1b\]8;;[^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "");
    expect(visible).toBe("See ~/a/story and ~/a/story/review.md, or https://example.com/x.");
    expect(out).toContain("\x1b]8;;file:///Users/me/a/story/review.md\x07");
    expect(out).toContain("\x1b]8;;https://example.com/x\x07");
  });
});

describe("when something happens next", () => {
  it("names a weekday only in the coming week, and the date further out", () => {
    vi.useFakeTimers();
    try {
      const now = new Date(2026, 9, 17, 4, 43); // a Saturday
      vi.setSystemTime(now);
      const at = (days: number, h = 4, m = 42) => new Date(2026, 9, 17 + days, h, m);
      const time = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const date = (d: Date) => `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time(d)}`;
      expect(when(at(0, 9, 0).toISOString())).toBe(`at ${time(at(0, 9, 0))}`);
      expect(when(at(1).toISOString())).toBe(`tomorrow ${time(at(1))}`);
      expect(when(at(6).toISOString())).toBe(`${at(6).toLocaleDateString([], { weekday: "short" })} ${time(at(6))}`);
      // A minute short of a week: Saturday again, so it says the date, not "Sat".
      expect(when(at(7).toISOString())).toBe(date(at(7)));
      expect(when(at(12).toISOString())).toBe(date(at(12)));
      // The agent list (TUI and overtime ls) says it the same way.
      const s = statusParts({ name: "a", status: "asleep", nextWake: at(7).toISOString() } as any);
      expect(s.detail).toBe(`wakes ${date(at(7))}`);
    } finally {
      vi.useRealTimers();
    }
  });
});
