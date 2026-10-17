import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { StdinBuffer } from "@earendil-works/pi-tui";
import { sequenceEnd, wholeSequences } from "../src/tui/input.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wheel = "\x1b[<65;57;41M";

describe("escape sequences from the terminal stay whole", () => {
  it("knows where a CSI sequence ends, and when it can't go on", () => {
    expect(sequenceEnd(wheel)).toBe(wheel.length);
    expect(sequenceEnd(`${wheel}after`)).toBe(wheel.length);
    for (let i = 1; i < wheel.length; i++) expect(sequenceEnd(wheel.slice(0, i))).toBe("more");
    expect(sequenceEnd("\x1b[A")).toBe(3);
    expect(sequenceEnd("\x1b[M ab")).toBe(6);
    expect(sequenceEnd("\x1bb")).toBe("broken"); // Option+← in macOS Terminal: a key of its own
    expect(sequenceEnd("\x1b[\x1b[A")).toBe("broken");
    expect(sequenceEnd("abc")).toBe("broken");
  });

  it("passes keys straight through, and still delivers Escape and Alt+[ on their own once nothing follows", async () => {
    const got: string[] = [];
    const input = wholeSequences((d) => got.push(d), 5);
    input("a");
    input("\x1b[A");
    input("\x1bb");
    expect(got).toEqual(["a", "\x1b[A", "\x1bb"]);
    input("\x1b");
    expect(got.length).toBe(3);
    await sleep(40);
    input("\x1b[");
    await sleep(40);
    input("x");
    expect(got).toEqual(["a", "\x1b[A", "\x1bb", "\x1b", "\x1b[", "x"]);
    // Escape, then a key that can't continue it: both, at once.
    input("\x1b");
    input("q");
    expect(got.slice(-2)).toEqual(["\x1b", "q"]);
  });

  it("joins a wheel report whose start the terminal library let go too early while the app was busy", async () => {
    // A real pipe and the library's own input buffer: the start of the report comes first, the rest 20 ms
    // later, but every read is followed by 120 ms of drawing, so the library's 50 ms timer goes off first.
    const run = async (wrap: boolean) => {
      const got: string[] = [];
      const deliver = wrap ? wholeSequences((d) => got.push(d)) : (d: string) => void got.push(d);
      const buf = new StdinBuffer();
      buf.on("data", deliver);
      const child = spawn(process.execPath, ["-e", `process.stdout.write("\\x1b["); setTimeout(() => process.stdout.write(${JSON.stringify(`${wheel.slice(2)}after`)}), 20)`]);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        buf.process(d);
        const t = Date.now();
        while (Date.now() - t < 120);
      });
      await new Promise((r) => child.on("close", r));
      await sleep(300);
      buf.destroy();
      return got;
    };
    // Without it, the report's text is typed (this is what reached the message box).
    expect((await run(false)).join("")).toContain("<65;57;41Mafter");
    expect(await run(true)).toEqual([wheel, ..."after"]);
  });
});
