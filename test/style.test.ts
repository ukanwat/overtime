import { describe, it, expect } from "vitest";
import { shimmer, cut } from "../src/tui/style.js";

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
