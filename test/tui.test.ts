import { describe, it, expect, beforeAll, afterAll } from "vitest";
import xterm from "@xterm/headless";
import type { Terminal as PiTerminal } from "@earendil-works/pi-tui";
import { fakeHome, until } from "./helpers.js";

fakeHome();
const { Runtime } = await import("../src/daemon/runtime.js");
const { ControlServer } = await import("../src/daemon/control.js");
const { DaemonClient } = await import("../src/daemon/client.js");
const { runApp } = await import("../src/tui/app.js");

/** A terminal for tests: everything written goes into a headless xterm, so we can read the screen. */
class TestTerminal implements PiTerminal {
  term = new xterm.Terminal({ cols: 110, rows: 32, allowProposedApi: true });
  private onInput: (d: string) => void = () => {};
  start(onInput: (d: string) => void) {
    this.onInput = onInput;
  }
  stop() {}
  async drainInput() {}
  write(d: string) {
    this.term.write(d);
  }
  get columns() {
    return 110;
  }
  get rows() {
    return 32;
  }
  get kittyProtocolActive() {
    return false;
  }
  moveBy(n: number) {
    this.term.write(n > 0 ? `\x1b[${n}B` : n < 0 ? `\x1b[${-n}A` : "");
  }
  hideCursor() {}
  showCursor() {}
  clearLine() {
    this.term.write("\x1b[2K");
  }
  clearFromCursor() {
    this.term.write("\x1b[J");
  }
  clearScreen() {
    this.term.write("\x1b[2J\x1b[H");
  }
  setTitle() {}
  setProgress() {}
  press(d: string) {
    this.onInput(d);
  }
  type(s: string) {
    for (const ch of s) this.onInput(ch);
  }
  async screen(): Promise<string> {
    await new Promise<void>((r) => this.term.write("", r));
    const b = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < this.term.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
    return lines.join("\n");
  }
}

const KEY = { enter: "\r", esc: "\x1b", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", tab: "\t", ctrlN: "\x0e", ctrlL: "\x0c", ctrlO: "\x0f", ctrlF: "\x06" };

const rt = new Runtime(() => {});
let control: InstanceType<typeof ControlServer>;
const t = new TestTerminal();
const opened: string[] = [];
let stop: () => void;

const seen = async (text: string, ms = 30_000) => {
  try {
    return await until(async () => (await t.screen()).includes(text), ms, `"${text}" on screen`);
  } catch (e) {
    console.log("SCREEN:\n" + (await t.screen()));
    throw e;
  }
};

beforeAll(async () => {
  await rt.start();
  control = new ControlServer(rt, () => {}, () => {});
  await control.start();
  const client = await DaemonClient.connect();
  ({ stop } = await runApp({ terminal: t, client, onQuit: () => {}, opener: (x) => opened.push(x) }));
});
afterAll(async () => {
  stop();
  await control.stop();
  await rt.stop();
});

describe("terminal app", () => {
  it("starts empty and explains what to do", async () => {
    await seen("No agents yet");
    expect(await t.screen()).toContain("New agent");
  });

  it("creates an agent from just a name and opens its greeting", async () => {
    t.press(KEY.ctrlN);
    await seen("It starts with no identity");
    t.type("alpha");
    t.press(KEY.enter);
    await seen("What should I be looking after");
    expect(await t.screen()).toContain("← alpha");
  });

  it("sends the first message and shows the agent's reply live", async () => {
    t.type("Your job is testing the app.");
    t.press(KEY.enter);
    await seen("main reply in th_", 40_000);
  });

  it("lists threads and answers a question with one key", async () => {
    t.press(KEY.esc);
    t.type("PASS ASK");
    t.press(KEY.enter);
    await seen("chat reply to: PASS ASK", 40_000);
    t.press(KEY.esc);
    await seen("Bridge or ferry?", 40_000);
    await seen("waiting on you");
    // select the question thread: it's the newest, at the bottom, selected by default
    const before = await t.screen();
    expect(before).toContain("Bridge or ferry?");
    t.press(KEY.right);
    for (let i = 0; i < 10; i++) t.press(KEY.down);
    t.press(KEY.enter);
    await seen("I'd recommend:");
    t.press("1");
    await seen("Answered: Bridge");
  });

  it("opens links from a thread with the keyboard", async () => {
    t.press(KEY.esc);
    const home = process.env.OVERTIME_HOME!;
    t.type(`look at ${home}/agents/alpha/AGENT.md please`);
    t.press(KEY.enter);
    await seen("[1]", 40_000);
    t.press(KEY.ctrlL);
    t.press(KEY.enter);
    await until(async () => opened.length > 0, 5_000, "link opened");
    expect(opened[0]).toContain("AGENT.md");
  });

  it("shows what's behind an agent", async () => {
    t.press(KEY.ctrlO);
    await seen("Behind alpha");
    expect(await t.screen()).toContain("Run transcripts");
    t.press(KEY.esc);
  });

  it("never draws a line wider than the terminal", async () => {
    const s = await t.screen();
    expect(s.split("\n").every((l) => l.length <= 110)).toBe(true);
  });
});
