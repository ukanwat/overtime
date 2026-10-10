import { describe, it, expect } from "vitest";
import { clipboardCommands, copyText } from "../src/tui/clipboard.js";

describe("copying a selection", () => {
  it("uses the platform's own clipboard tool, not only OSC 52 (Terminal.app ignores it)", () => {
    expect(clipboardCommands("darwin", {})).toEqual([["pbcopy"]]);
    expect(clipboardCommands("linux", { WAYLAND_DISPLAY: "wayland-0" })[0]).toEqual(["wl-copy"]);
    expect(clipboardCommands("linux", { DISPLAY: ":0" }).map((c) => c[0])).toEqual(["xclip", "xsel"]);
    expect(clipboardCommands("linux", {})).toEqual([]);
  });

  it("falls back to OSC 52 when no tool works, and over SSH", async () => {
    const seqs: string[] = [];
    expect(await copyText("héllo", (s) => seqs.push(s), "linux", {})).toBe(true);
    expect(await copyText("x", (s) => seqs.push(s), "darwin", { SSH_TTY: "/dev/ttys001" })).toBe(true);
    expect(seqs).toEqual([`\x1b]52;c;${Buffer.from("héllo").toString("base64")}\x07`, `\x1b]52;c;${Buffer.from("x").toString("base64")}\x07`]);
  });
});
