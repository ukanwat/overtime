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

  it("shows a question inline; a number picks an option and Enter answers", async () => {
    t.type("PASS ASK");
    t.press(KEY.enter);
    await seen("Bridge or ferry?", 40_000);
    await seen("Press 1–2 to choose");
    t.press("1");
    await seen("Enter to answer, Esc to cancel"); // one key alone never answers
    t.press(KEY.enter);
    await seen("Answered: Bridge");
    await seen("You chose Bridge");
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
    await seen("enter save"); // the key hints live in the bottom bar
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
    expect(s).toContain("Press 1–3 to choose, or type a message");
    expect(s).toContain("▌ repo-keeper");
  });

  it("scrolls back through the conversation with PgUp and forward with PgDn", async () => {
    const { t, seen } = await open(120, 14);
    await seen("lines above");
    const before = await t.screen();
    t.press(KEY.pgup);
    await new Promise((r) => setTimeout(r, 300));
    const up = await t.screen();
    expect(up).not.toEqual(before);
    t.press("\x1b[6~");
    await new Promise((r) => setTimeout(r, 300));
    expect(await t.screen()).toEqual(before);
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
    expect(s).toContain("✓ You chose Dusk");
    expect(s).not.toContain("Press 1–2");
  });

  it("lets you scroll past an open question to newer messages without pulling you back", async () => {
    const c: any = new FakeClient();
    const iso = (m: number) => new Date(Date.now() - m * 60000).toISOString();
    const long = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of the newer update.`).join("\n");
    const orig = c.call.bind(c);
    c.call = async (m: string, p: any) =>
      m === "messages" && p?.name === "repo-keeper"
        ? { messages: [{ id: "q", t: iso(5), from: "agent", kind: "question", text: "Bridge or ferry?", options: ["Bridge", "Ferry"] }, { id: "n", t: iso(1), from: "agent", kind: "message", text: long }], hasMore: false }
        : orig(m, p);
    const { t, app, seen } = await open(100, 18, c);
    await seen("Bridge or ferry?"); // arrives on the open question
    for (let i = 0; i < 5; i++) t.press("\x1b[6~"); // PgDn to the bottom
    await seen("Line 12 of the newer update.");
    // Redraws (a spinner tick, a refresh) must not move the view back up.
    for (let i = 0; i < 5; i++) {
      await (app as any).refresh();
      await new Promise((r) => setTimeout(r, 50));
      expect(await t.screen()).toContain("Line 12 of the newer update.");
    }
  });

  it("asks before archiving, with Cancel selected first", async () => {
    const { t, c, seen } = await open();
    await seen("Merge the dependency fix?");
    const archive = async () => {
      t.press("\x1b[C"); // → settings
      await seen("CONTROL");
      for (let i = 0; i < 8; i++) t.press(KEY.down); // Backend, Model, budgets, workspace, protected, wake, stop, archive
      t.press(KEY.enter);
      await seen("Archive repo-keeper?");
    };
    await archive();
    expect(await t.screen()).toContain("Nothing is deleted");
    t.press(KEY.enter); // Cancel is selected: nothing happens
    await new Promise((r) => setTimeout(r, 300));
    expect(c.calls.some((x) => x.method === "archive")).toBe(false);
    expect(await t.screen()).not.toContain("Archive repo-keeper?");
    await archive();
    t.press("\x1b[D"); // ← to Archive
    t.press(KEY.enter);
    await new Promise((r) => setTimeout(r, 300));
    expect(c.calls.some((x) => x.method === "archive" && x.params.name === "repo-keeper")).toBe(true);
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

  it("keeps the line breaks of a pasted block and sends it as written", async () => {
    const { t, c, seen } = await open();
    await seen("Merge the dependency fix?");
    t.press(paste("first line\nsecond line\nthird line"));
    await seen("second line");
    const s = (await t.screen()).split("\n");
    // Three separate rows in the message box, not one run-together line.
    expect(s.some((l) => l.includes("first line") && !l.includes("second"))).toBe(true);
    t.press(KEY.enter);
    await new Promise((r) => setTimeout(r, 300));
    const sent = c.calls.find((x) => x.method === "send");
    expect(sent?.params.text).toBe("first line\nsecond line\nthird line");
  });

  it("starts a new line with Shift+Enter (or Ctrl+J), and ↑↓ move through its lines", async () => {
    const { t, c, seen } = await open();
    await seen("Merge the dependency fix?");
    t.type("one");
    t.press("\n"); // Ctrl+J
    t.type("two");
    await seen("two");
    t.press(KEY.up); // moves within the message, not to another agent
    await new Promise((r) => setTimeout(r, 200));
    expect(await t.screen()).toContain("▌ repo-keeper");
    t.press(KEY.enter);
    await new Promise((r) => setTimeout(r, 300));
    expect(c.calls.find((x) => x.method === "send")?.params.text).toBe("one\ntwo");
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
