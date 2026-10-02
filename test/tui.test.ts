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
  term: InstanceType<typeof xterm.Terminal>;
  private onInput: (d: string) => void = () => {};
  constructor(readonly cols = 110, readonly rowCount = 32) {
    this.term = new xterm.Terminal({ cols, rows: rowCount, allowProposedApi: true });
  }
  start(onInput: (d: string) => void) {
    this.onInput = onInput;
  }
  stop() {}
  async drainInput() {}
  write(d: string) {
    this.term.write(d);
  }
  get columns() {
    return this.cols;
  }
  get rows() {
    return this.rowCount;
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

const KEY = { enter: "\r", esc: "\x1b", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", tab: "\t", bs: "\x7f", ctrlN: "\x0e", ctrlL: "\x0c", ctrlO: "\x0f", ctrlF: "\x06", ctrlP: "\x10", ctrlS: "\x13", ctrlT: "\x14", ctrlR: "\x12" };

function seer(t: TestTerminal) {
  return async (text: string, ms = 30_000) => {
    try {
      return await until(async () => (await t.screen()).includes(text), ms, `"${text}" on screen`);
    } catch (e) {
      console.log("SCREEN:\n" + (await t.screen()));
      throw e;
    }
  };
}

describe("terminal app, against a real daemon", () => {
  const rt = new Runtime(() => {});
  let control: InstanceType<typeof ControlServer>;
  const t = new TestTerminal();
  const seen = seer(t);
  const opened: string[] = [];
  let stop: () => void;

  beforeAll(async () => {
    await rt.start();
    control = new ControlServer(rt, () => {}, () => {});
    await control.start();
    const client = await DaemonClient.connect();
    ({ stop } = await runApp({ terminal: t, client, onQuit: () => {}, opener: (x) => void opened.push(x) }));
  });
  afterAll(async () => {
    stop();
    await control.stop();
    await rt.stop();
  });

  it("starts empty and says what to do first", async () => {
    await seen("Welcome to Overtime");
    const s = await t.screen();
    expect(s).toContain("No agents yet");
    expect(s).toContain("Press Ctrl+N");
    expect(s).toContain("+ New agent");
  });

  it("creates an agent from just a name, checking the name as you type", async () => {
    t.press(KEY.ctrlN);
    await seen("It starts with no job");
    t.type("Bad");
    await seen("lowercase letters");
    for (let i = 0; i < 3; i++) t.press(KEY.bs);
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

  it("puts questions first and answers one with a single key", async () => {
    t.press(KEY.esc);
    t.type("PASS ASK");
    t.press(KEY.enter);
    await seen("chat reply to: PASS ASK", 40_000);
    t.press(KEY.esc);
    await seen("NEEDS YOU", 40_000);
    await seen("Bridge or ferry?");
    // Questions are listed first, at the top.
    for (let i = 0; i < 5; i++) t.press(KEY.up);
    t.press(KEY.enter);
    await seen("Recommended");
    await seen("Press 1–2 to answer");
    t.press("1");
    await seen("Answered: Bridge");
  });

  it("opens links from a thread with the keyboard", async () => {
    t.press(KEY.esc);
    const home = process.env.OVERTIME_HOME!;
    t.type(`look at ${home}/agents/alpha/AGENT.md please`);
    t.press(KEY.enter);
    await seen("↗", 40_000);
    t.press(KEY.ctrlL);
    t.press(KEY.enter);
    await until(async () => opened.length > 0, 5_000, "link opened");
    expect(opened[0]).toContain("AGENT.md");
  });

  it("shows what's behind an agent", async () => {
    t.press(KEY.ctrlO);
    await seen("Behind alpha");
    expect(await t.screen()).toContain("Transcripts");
    t.press(KEY.esc);
  });

  it("lists every action in one menu", async () => {
    t.press(KEY.ctrlP);
    await seen("Actions");
    const s = await t.screen();
    for (const a of ["Wake now", "Stop", "Backend and model", "Archive", "New agent"]) expect(s).toContain(a);
    t.press(KEY.esc);
  });

  it("changes the backend and model from a picker", async () => {
    t.press(KEY.ctrlT);
    await seen("alpha runs on");
    t.press(KEY.enter);
    await seen("alpha · fake model");
    await seen("Default");
    t.press(KEY.enter);
    await seen("alpha will use fake");
  });

  it("stops and starts an agent with one key", async () => {
    t.press(KEY.ctrlS);
    await seen("Stopped alpha");
    await seen("■ stopped");
    t.press(KEY.ctrlS);
    await seen("Started alpha");
  });

  it("never draws a line wider than the terminal", async () => {
    const s = await t.screen();
    expect(s.split("\n").every((l) => l.length <= 110)).toBe(true);
  });
});

/** A daemon stand-in with fixed data, for layout, clicks and streaming. */
function fakeClient() {
  const now = Date.now();
  const iso = (m: number) => new Date(now - m * 60000).toISOString();
  const agent = (name: string, o: object) => ({ name, status: "asleep", activity: "", nextWake: null, pausedUntil: null, waiting: 0, unread: 0, helpersRunning: 0, spentUsd: 0, costReported: true, tokensToday: 0, budgetUsd: 10, backend: "claude", model: null, lastError: null, dir: `/tmp/agents/${name}`, ...o });
  const agents = [agent("keeper", { activity: "watching CI", waiting: 1 }), agent("builder", { status: "working", activity: "building" })];
  const threads: Record<string, any[]> = {
    keeper: [
      { id: "th_q", kind: "question", title: "Merge the fix?", status: "waiting_on_you", createdAt: iso(5), updatedAt: iso(5), unread: 1 },
      { id: "th_c", kind: "conversation", title: "About CI", status: "open", createdAt: iso(60), updatedAt: iso(60), unread: 0 },
    ],
    builder: [],
  };
  const entries: Record<string, any[]> = {
    th_q: [{ id: "e", t: iso(5), from: "agent", text: "Tests pass. Merge?", recommendation: "Merge it.", options: ["Merge", "Wait"] }],
    th_c: [{ id: "e", t: iso(60), from: "you", text: "How is CI?" }],
  };
  const calls: { method: string; params: any }[] = [];
  return {
    calls,
    isClosed: false,
    closed: new Promise<void>(() => {}),
    async subscribe() {},
    close() {},
    async call(method: string, params: any = {}) {
      calls.push({ method, params });
      if (method === "agents") return agents;
      if (method === "threads") return threads[params.name] ?? [];
      if (method === "thread") return { meta: Object.values(threads).flat().find((x) => x.id === params.id), entries: entries[params.id] ?? [] };
      if (method === "live") return [];
      return { ok: true };
    },
  };
}

describe("terminal app, layout and streaming", () => {
  it("streams what the agent is writing into the open thread, and its current step into the list", async () => {
    const t = new TestTerminal(110, 30);
    const seen = seer(t);
    const { app, stop } = await runApp({ terminal: t, client: fakeClient() as any, onQuit: () => {} });
    try {
      await seen("keeper");
      app.onLive({ agent: "builder", kind: "main", text: "", step: "Bash: npm test", startedAt: new Date().toISOString() });
      await seen("Bash: npm test");
      // Open "About CI": the question is listed first, so it's the second thread.
      t.press(KEY.right);
      t.press(KEY.down);
      t.press(KEY.enter);
      await seen("How is CI?");
      app.onLive({ agent: "keeper", kind: "chat", threadId: "th_c", text: "CI is green on main\x1b[2J", step: null, startedAt: new Date().toISOString() });
      await seen("CI is green on main");
      expect(await t.screen()).toContain("writing…");
      app.onLive({ agent: "keeper", kind: "chat", threadId: "th_c", text: "", step: null, startedAt: new Date().toISOString(), done: true });
      await until(async () => !(await t.screen()).includes("CI is green on main"), 5_000, "live text gone");
    } finally {
      stop();
    }
  });

  it("answers by clicking an option", async () => {
    const t = new TestTerminal(110, 30);
    const seen = seer(t);
    const c = fakeClient();
    const { app, stop } = await runApp({ terminal: t, client: c as any, onQuit: () => {} });
    try {
      await seen("keeper");
      t.press(KEY.right);
      t.press(KEY.enter);
      await seen("Merge it.");
      const lines = (await t.screen()).split("\n");
      const row = lines.findIndex((l) => l.includes(" 2 ") && l.includes("Wait"));
      expect(row).toBeGreaterThan(0);
      app.handleMouse({ type: "click", button: "left", screenX: lines[row].indexOf("Wait"), screenY: row, x: 0, y: 0, width: 110, height: 30, shift: false } as any);
      await until(async () => c.calls.some((x) => x.method === "answer" && x.params.choice === 2), 5_000, "answer sent");
    } finally {
      stop();
    }
  });

  it("shows one pane at a time on a narrow terminal", async () => {
    const t = new TestTerminal(64, 22);
    const seen = seer(t);
    const { stop } = await runApp({ terminal: t, client: fakeClient() as any, onQuit: () => {} });
    try {
      await seen("AGENTS");
      expect(await t.screen()).not.toContain("NEEDS YOU");
      t.press(KEY.right);
      await seen("NEEDS YOU");
      expect(await t.screen()).not.toContain("AGENTS");
      t.press(KEY.left);
      await seen("AGENTS");
      expect((await t.screen()).split("\n").every((l) => l.length <= 64)).toBe(true);
    } finally {
      stop();
    }
  });
});
