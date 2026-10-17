import { describe, it, expect, vi } from "vitest";
import { shimmer, cut, statusParts, when } from "../src/tui/style.js";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("the working shimmer", () => {
  it("never changes or garbles the text, whatever the moment", () => {
    delete process.env.OVERTIME_STILL;
    const text = cut("working · Treatment + first look frame for The Walk to the Sea", 30);
    for (let t = 0; t < 5000; t += 37) {
      const s = shimmer(text, t);
      expect(plain(s)).toBe(text);
      expect(s).not.toMatch(/\x1b(?!\[[0-9;]*m)/); // every escape is a complete colour code
    }
  });

  it("strips escape codes it's handed rather than splitting them", () => {
    expect(plain(shimmer("abc\x1b[0m...", 500))).toBe("abc...");
  });

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
