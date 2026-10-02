import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHome, until } from "./helpers.js";
import { FakeClient, TestTerminal } from "./tui-fake.js";

fakeHome();
const { Runtime } = await import("../src/daemon/runtime.js");
const { ControlServer } = await import("../src/daemon/control.js");
const { DaemonClient } = await import("../src/daemon/client.js");
const { runApp } = await import("../src/tui/app.js");
const style = await import("../src/tui/style.js");

const KEY = { enter: "\r", esc: "\x1b", up: "\x1b[A", down: "\x1b[B", tab: "\t", bs: "\x7f", pgup: "\x1b[5~", ctrlN: "\x0e", ctrlL: "\x0c", ctrlS: "\x13", ctrlT: "\x14", ctrlR: "\x12" };
const paste = (s: string) => `\x1b[200~${s}\x1b[201~`;

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
  const t = new TestTerminal(110, 34);
  const seen = seer(t);
  const opened: string[] = [];
  let stop: () => void;

  beforeAll(async () => {
    await rt.start();
    control = new ControlServer(rt, () => {}, () => {});
    await control.start();
    const client = await DaemonClient.connect();
    ({ stop } = await runApp({ terminal: t as any, client, onQuit: () => {}, opener: (x) => void opened.push(x) }));
  });
  afterAll(async () => {
    stop();
    await control.stop();
    await rt.stop();
  });

  it("starts on a welcome with + New agent selected, and says what to do", async () => {
    await seen("Welcome to Overtime");
    const s = await t.screen();
    expect(s).toContain("+ New agent");
    expect(s).toContain("Type a name below and press Enter");
    expect(s).toContain("Name the new agent");
  });

  it("creates an agent by typing a name, checking it as you type", async () => {
    t.type("Bad");
    await seen("lowercase letters");
    for (let i = 0; i < 3; i++) t.press(KEY.bs);
    t.type("alpha");
    await seen("Press Enter to create alpha");
    t.press(KEY.enter);
    await seen("What should I be looking after");
    const s = await t.screen();
    expect(s).toContain("◇ new");
    expect(s).toContain("Tell alpha what it's for");
  });

  it("sends a message and shows the reply in one conversation", async () => {
    t.type("Your job is testing the app.");
    t.press(KEY.enter);
    await seen("Your job is testing the app.");
    await seen("main reply", 40_000);
  });

  it("shows a question inline and answers it with one key", async () => {
    t.type("PASS ASK");
    t.press(KEY.enter);
    await seen("Bridge or ferry?", 40_000);
    await seen("Press 1–2 to answer");
    t.press("1");
    await seen("Answered: Bridge");
    await seen("✓ Bridge");
  });

  it("opens links with the keyboard", async () => {
    const home = process.env.OVERTIME_HOME!;
    t.type(`look at ${home}/agents/alpha/AGENT.md please`);
    t.press(KEY.enter);
    await seen("↗", 40_000);
    t.press(KEY.ctrlL);
    t.press(KEY.enter);
    await until(async () => opened.length > 0, 5_000, "link opened");
    expect(opened.at(-1)).toContain("alpha");
  });

  it("attaches a dragged-in file and sends it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ot-attach-"));
    const f = join(dir, "notes for you.txt");
    writeFileSync(f, "hello");
    t.press(paste(`'${f}'`));
    await seen("📎 notes for you.txt");
    await seen("Backspace removes the last");
    t.type("here are my notes");
    t.press(KEY.enter);
    await seen("here are my notes", 40_000);
    await until(async () => !(await t.screen()).includes("Backspace removes the last"), 10_000, "chips cleared");
    expect(await t.screen()).toContain("notes for you.txt");
  });

  it("changes the daily budget from settings", async () => {
    t.press(KEY.tab);
    await seen("RUNS ON");
    await seen("Daily budget");
    // Backend, Model, then Daily budget.
    t.press(KEY.down);
    t.press(KEY.down);
    t.press(KEY.enter);
    await seen("Enter saves");
    for (let i = 0; i < 6; i++) t.press(KEY.bs);
    t.type("abc");
    t.press(KEY.enter);
    await seen("Type a number of dollars");
    for (let i = 0; i < 3; i++) t.press(KEY.bs);
    t.type("25");
    t.press(KEY.enter);
    await seen("Daily budget saved");
    await seen("$25 a day");
    t.press(KEY.esc);
  });

  it("changes the backend and model from a picker", async () => {
    t.press(KEY.ctrlT);
    await seen("alpha runs on");
    t.press(KEY.enter);
    await seen("fake models for alpha");
    await seen("Default");
    t.press(KEY.enter);
    await seen("alpha will use fake");
  });

  it("stops and starts an agent", async () => {
    t.press(KEY.ctrlS);
    await seen("Stopped alpha");
    await seen("■ stopped");
    t.press(KEY.ctrlS);
    await seen("Started alpha");
  });

  it("moves to + New agent with the arrow keys alone", async () => {
    t.press(KEY.down);
    await seen("Name the new agent");
    t.press(KEY.up);
    await seen("Message alpha");
  });

  it("never draws a line wider than the terminal", async () => {
    const s = await t.screen();
    expect(s.split("\n").every((l) => l.length <= 110)).toBe(true);
  });
});

describe("terminal app, with a scripted daemon", () => {
  let stops: (() => void)[] = [];
  afterEach(() => {
    for (const s of stops) s();
    stops = [];
    style.resetPalette();
  });
  async function open(cols = 120, rows = 36, c = new FakeClient()) {
    const t = new TestTerminal(cols, rows);
    const opened: string[] = [];
    const r = await runApp({ terminal: t as any, client: c as any, onQuit: () => {}, opener: (x) => void opened.push(x) });
    stops.push(r.stop);
    return { t, c, app: r.app, seen: seer(t), opened };
  }

  it("opens on the agent that needs you, with its question in view", async () => {
    const { t, seen } = await open();
    await seen("Merge the dependency fix?");
    const s = await t.screen();
    expect(s).toContain("1  Merge it");
    expect(s).toContain("Press 1–3 to answer, or type a message");
    expect(s).toContain("▌ repo-keeper");
  });

  it("moves through agents with ↑↓ and the conversation follows", async () => {
    const { t, seen } = await open();
    await seen("Merge the dependency fix?");
    t.press(KEY.down);
    await seen("Harbour blockout done");
    expect(await t.screen()).toContain("▌ game-builder");
    for (let i = 0; i < 4; i++) t.press(KEY.down);
    await seen("Name the new agent");
  });

  it("shows answered questions with the chosen answer", async () => {
    const { t, seen } = await open();
    t.press(KEY.down);
    await seen("Night or dusk");
    const s = await t.screen();
    expect(s).toContain("✓ Dusk");
    expect(s).not.toContain("Press 1–2");
  });

  it("answers by clicking an option", async () => {
    const { t, c, seen } = await open();
    await seen("Merge the dependency fix?");
    const lines = (await t.screen()).split("\n");
    const y = lines.findIndex((l) => l.includes("2  Wait for 1.35"));
    const x = lines[y].indexOf("2  Wait");
    t.press(`\x1b[<0;${x + 1};${y + 1}M`);
    t.press(`\x1b[<0;${x + 1};${y + 1}m`);
    await until(async () => c.calls.some((k) => k.method === "answer" && k.params.choice === 2), 5_000, "answered by click");
  });

  it("streams what the agent is writing, and its current step in the list", async () => {
    const { t, app, seen } = await open();
    await seen("Merge the dependency fix?");
    app.onLive({ agent: "repo-keeper", kind: "chat", text: "Checking the last three CI runs now", step: null, startedAt: new Date().toISOString() });
    app.onLive({ agent: "game-builder", kind: "main", text: "", step: "Bash: npm test", startedAt: new Date().toISOString() });
    await seen("Checking the last three CI runs now");
    await seen("writing…");
    await seen("Bash: npm test");
    app.onLive({ agent: "repo-keeper", kind: "chat", text: "", step: null, startedAt: "", done: true });
    await until(async () => !(await t.screen()).includes("Checking the last three"), 5_000, "stream cleared");
  });

  it("drops a non-file paste into the composer as text", async () => {
    const { t, seen } = await open();
    await seen("Merge the dependency fix?");
    t.press(paste("just some text"));
    await seen("just some text");
    expect(await t.screen()).not.toContain("📎 just");
  });

  it("shows one pane on a narrow terminal and still switches agents with ↑↓", async () => {
    const { t, seen } = await open(70, 24);
    await seen("1/5 ↑↓");
    expect((await t.screen()).split("\n").every((l) => l.length <= 70)).toBe(true);
    t.press(KEY.down);
    await seen("game-builder  2/5");
  });

  it("uses one accent, yellow only for what needs you, red only for failures, on a dark theme", async () => {
    style.applyTerminalColors({ background: { r: 12, g: 12, b: 12 }, foreground: { r: 224, g: 224, b: 224 } }, true);
    const { t, seen } = await open(120, 70);
    await seen("Merge the dependency fix?");
    const lines = (await t.screen()).split("\n");
    const at = async (needle: string) => {
      const y = lines.findIndex((l) => l.includes(needle));
      return t.cell(lines[y].indexOf(needle), y);
    };
    const hex = (n: number | undefined) => "#" + (n ?? 0).toString(16).padStart(6, "0");
    expect(hex((await at("◆")).fg)).toBe("#5c9cf5");
    expect(hex((await at("1 needs you")).fg)).toBe("#e5c07b");
    expect(hex((await at("Something keeps failing")).fg)).toBe("#e06c75");
    expect((await at("Got it.")).fgMode).toBe(0); // body text in the terminal's own colour
  });

  it("keeps working with NO_COLOR", async () => {
    process.env.NO_COLOR = "1";
    try {
      const { t, seen } = await open();
      await seen("Merge the dependency fix?");
      const lines = (await t.screen()).split("\n");
      const y = lines.findIndex((l) => l.includes("◆"));
      expect((await t.cell(lines[y].indexOf("◆"), y)).fgMode).toBe(0);
    } finally {
      delete process.env.NO_COLOR;
    }
  });
});
