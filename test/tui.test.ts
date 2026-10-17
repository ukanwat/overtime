import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
process.env.OVERTIME_STILL = "1"; // still frames: screenshots compared across moments must not differ by an animation
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHome, until } from "./helpers.js";
import { visibleWidth } from "@earendil-works/pi-tui";
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
    control.open();
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
    // Enter shows its settings first, with Create selected: Enter twice makes it with the defaults.
    t.press(KEY.enter);
    t.press(KEY.enter);
    await seen("What should I be looking after");
    const { loadAgent } = await import("../src/agent/agent.js");
    expect((await loadAgent("alpha")).settings).toEqual({}); // nothing chosen: it follows the defaults
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

  it("lists its skills when you type /, narrowing as you type; the agent is told to use the one you chose", async () => {
    t.type("/");
    await seen("/overtime-docs");
    t.type("ovdoc");
    await seen("/overtime-docs");
    t.press(KEY.enter); // chooses it: "/overtime-docs " in the message, nothing sent yet
    t.type("where do MCP servers go?");
    await seen("/overtime-docs where do MCP servers go?");
    t.press(KEY.enter);
    const { readFileSync, existsSync } = await import("node:fs");
    const f = join(process.env.OVERTIME_HOME!, "agents", "alpha", ".overtime", "inbox-delivered.jsonl");
    await until(async () => existsSync(f) && readFileSync(f, "utf8").includes('load your \\"overtime-docs\\" skill'), 30_000, "skill note delivered");
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
    await seen("✓ 1  Bridge  · your answer");
  });

  it("opens links with the keyboard", async () => {
    const home = process.env.OVERTIME_HOME!;
    t.type(`look at ${home}/agents/alpha/AGENT.md please`);
    t.press(KEY.enter);
    await seen("main reply to: look at", 40_000);
    // The path is clickable in the text, and listed under the message.
    expect(t.raw).toContain(`\x1b]8;;file://`);
    await seen("↗");
    t.press(KEY.ctrlL); // pick it with the keyboard
    await seen("Enter opens");
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
    return { t, c, app: r.app, tui: r.tui, seen: seer(t), opened };
  }
  const click = (t: TestTerminal, x: number, y: number) => {
    t.press(`\x1b[<0;${x + 1};${y + 1}M`);
    t.press(`\x1b[<0;${x + 1};${y + 1}m`);
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  it("shows a new agent's settings before making it, and makes it with the backend, model and budget chosen there", async () => {
    const { t, c, app, seen } = await open();
    await seen("Merge the dependency fix?");
    t.press(KEY.ctrlN);
    await seen("Name the new agent");
    t.type("coder");
    t.press(KEY.enter);
    await seen("New agent · coder");
    await seen("the default");
    await (app as any).refresh(); // other agents carrying on meanwhile don't close it
    await sleep(100);
    let s = await t.screen();
    for (const x of ["Backend", "claude", "Model", "Daily budget", "$10 a day", "Workspace", "its own folder", "Other agents", "› Create coder"]) expect(s).toContain(x);
    expect(c.calls.some((x) => x.method === "new")).toBe(false);
    // Up to the backend; its picker marks what isn't installed.
    for (let i = 0; i < 10 && !(await t.screen()).includes("› Backend"); i++) {
      t.press(KEY.up);
      await sleep(20);
    }
    t.press(KEY.enter);
    await seen("coder runs on");
    expect(await t.screen()).toMatch(/gemini\s+not installed/);
    t.press(KEY.down); // claude → codex
    t.press(KEY.enter);
    await seen("codex models for coder");
    await seen("Opus");
    t.press(KEY.down);
    t.press(KEY.enter);
    await seen("New agent · coder");
    s = await t.screen();
    expect(s).toMatch(/Backend\s+codex/);
    expect(s).toMatch(/Model\s+opus/);
    // The budget, typed in place.
    for (let i = 0; i < 10 && !(await t.screen()).includes("› Daily budget"); i++) {
      t.press(KEY.down);
      await sleep(20);
    }
    t.press(KEY.enter);
    for (let i = 0; i < 4; i++) t.press(KEY.bs);
    t.type("25");
    t.press(KEY.enter);
    await seen("$25 a day");
    for (let i = 0; i < 10 && !(await t.screen()).includes("› Create coder"); i++) {
      t.press(KEY.down);
      await sleep(20);
    }
    t.press(KEY.enter);
    await seen("Created coder");
    expect(c.calls.find((x) => x.method === "new")?.params).toEqual({ name: "coder", backend: "codex", model: "opus", dailyBudgetUsd: 25 });
    expect(await t.screen()).toContain("codex · opus");
  });

  it("won't make a new agent on a backend that isn't installed, and Esc goes back to its name", async () => {
    const c: any = new FakeClient();
    const call = c.call.bind(c);
    c.call = async (m: string, p: any) => (m === "defaults" ? { backend: "gemini", model: null, dailyBudgetUsd: 10 } : call(m, p));
    const { t, seen } = await open(120, 36, c);
    await seen("Merge the dependency fix?");
    t.press(KEY.ctrlN);
    await seen("Name the new agent");
    t.type("gem");
    t.press(KEY.enter);
    t.press(KEY.enter);
    await seen("gem can't run here: gemini isn't installed");
    expect(await t.screen()).toMatch(/Backend\s+gemini\s+not installed/);
    expect(c.calls.some((x: any) => x.method === "new")).toBe(false);
    t.press(KEY.esc);
    await seen("Press Enter to create gem");
    expect(c.calls.some((x: any) => x.method === "new")).toBe(false);
  });

  it("keeps the new agent's settings step and its choices when a backend that isn't installed is picked", async () => {
    const { t, c, seen } = await open(110, 34);
    await seen("Merge the dependency fix?");
    t.press(KEY.ctrlN);
    await seen("Name the new agent");
    t.type("tui3");
    t.press(KEY.enter);
    await seen("New agent · tui3");
    await seen("the default");
    // Other agents: public → private.
    for (let i = 0; i < 10 && !(await t.screen()).includes("› Other agents"); i++) {
      t.press(KEY.up);
      await sleep(20);
    }
    t.press(KEY.enter);
    await sleep(50);
    expect(await t.screen()).toMatch(/Other agents\s+private/);
    for (let i = 0; i < 10 && !(await t.screen()).includes("› Backend"); i++) {
      t.press(KEY.up);
      await sleep(20);
    }
    t.press(KEY.enter);
    await seen("tui3 runs on");
    t.press(KEY.down); // claude → codex
    t.press(KEY.down); // → gemini, not installed
    t.press(KEY.enter);
    await seen("gemini isn't installed");
    const s = await t.screen();
    expect(s).toContain("New agent · tui3");
    expect(s).toMatch(/Other agents\s+private/);
    expect(s).toMatch(/Backend\s+claude/);
    expect(c.calls.some((x) => x.method === "new")).toBe(false);
  });

  it("shows answered questions with the chosen answer", async () => {
    const { t, seen } = await open();
    t.press(KEY.down);
    await seen("Night or dusk");
    const s = await t.screen();
    // Every option keeps its number and label; the chosen one is marked.
    expect(s).toContain("  1  Night");
    expect(s).toContain("✓ 2  Dusk  · your answer");
    expect(s).not.toContain("Press 1–2");
    expect(s).not.toContain("Dismiss this question");
  });

  it("shows an answered question's note under its options, and dismissed ones with their options muted", async () => {
    const c = new FakeClient();
    const iso = (m: number) => new Date(Date.now() - m * 60000).toISOString();
    const long = "Bake the lighting at dusk and keep a second pass for night so both screenshots come from the same scene setup";
    c.data.messages["game-builder"] = [
      { id: "a", t: iso(90), from: "agent", kind: "question", title: "Which light?", text: "Which light?", options: ["Night", long], answer: { choice: 2, text: long, note: "Warmer if you can.", t: iso(89) } },
      { id: "b", t: iso(80), from: "agent", kind: "question", title: "Which camera?", text: "Which camera?", options: ["Wide", "Close"], answer: { closed: "dismissed", t: iso(79) } },
      { id: "c", t: iso(70), from: "agent", kind: "question", title: "Which sky?", text: "Which sky?", options: ["Clear", "Clouds"], answer: { text: "Fog, please", t: iso(69) } },
    ];
    const { t, app, seen } = await open(70, 40, c);
    await seen("Merge the dependency fix?");
    t.press(KEY.down);
    await seen("Which sky?");
    const s = await t.screen();
    expect(s).toContain("  1  Night");
    expect(s).toMatch(/✓ 2 {2}Bake the lighting/);
    expect(s).toContain("· your answer");
    expect(s).toContain("Warmer if you can.");
    expect(s.indexOf("Warmer if you can.")).toBeGreaterThan(s.indexOf("· your answer"));
    expect(s).toContain("  1  Wide");
    expect(s).toContain("  2  Close");
    expect(s).toContain("✕ You dismissed this question");
    expect(s).toContain("  1  Clear");
    expect(s).toContain("✓ You answered: Fog, please");
    expect(s).not.toContain("Enter to answer");
    // Answered cards take no clicks and no number keys.
    const lines = s.split("\n");
    const y = lines.findIndex((l) => l.includes("1  Night"));
    click(t, lines[y].indexOf("1  Night"), y);
    t.press("1");
    await sleep(300);
    expect(await t.screen()).not.toContain("Enter to answer");
    expect(c.calls.some((k) => k.method === "answer")).toBe(false);
    // No line is wider than the terminal, however long an option is.
    const a = (app as any).agents.find((x: any) => x.name === "game-builder");
    for (const l of (app as any).renderMessages(a, 50, 40, 20, 0)) expect(visibleWidth(l)).toBeLessThanOrEqual(50);
  });

  it("scrolls the messages with Shift+↑↓ while plain ↑↓ still move between agents", async () => {
    const { t, seen } = await open(120, 14);
    await seen("lines above");
    const before = await t.screen();
    t.press("\x1b[1;2A"); // Shift+↑
    await new Promise((r) => setTimeout(r, 300));
    const up = await t.screen();
    expect(up).not.toEqual(before);
    expect(up).toContain("▌ repo-keeper"); // still on the same agent
    t.press("\x1b[1;2B"); // Shift+↓
    await new Promise((r) => setTimeout(r, 300));
    expect(await t.screen()).toEqual(before);
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
      // Down until Archive… is the selected row, however many rows come before it.
      for (let i = 0; i < 30 && !(await t.screen()).includes("› Archive"); i++) {
        t.press(KEY.down);
        await new Promise((r) => setTimeout(r, 20));
      }
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

  it("shows messages between agents quietly, labelled with both names, and toggles whether others see it", async () => {
    const c = new FakeClient();
    const iso = (m: number) => new Date(Date.now() - m * 60000).toISOString();
    c.data.messages["repo-keeper"].push(
      { id: "x1", t: iso(2), from: "agent", kind: "agent-message", fromAgent: "repo-keeper", toAgent: "game-builder", text: "The harbour assets are in the release branch now." },
      { id: "x2", t: iso(1), from: "agent", kind: "agent-message", fromAgent: "game-builder", toAgent: "repo-keeper", text: "Thanks, pulling them in." },
    );
    c.data.agents[0].waiting = 0; // no open question to jump to: the newest messages are in view
    c.data.messages["repo-keeper"].find((m: any) => m.id === "m5").answer = { choice: 1, text: "Merge it", t: iso(20) };
    const { t, seen } = await open(110, 40, c);
    await seen("Thanks, pulling them in.");
    const s = await t.screen();
    expect(s).toContain("repo-keeper → game-builder");
    expect(s).toContain("game-builder → repo-keeper");
    expect(s).toContain("between agents");
    expect(s).toContain("The harbour assets are in the release branch now.");
    t.press("\x1b[C"); // → settings
    await seen("Other agents");
    // Under its own heading, not the budget's.
    const rows = (await t.screen()).split("\n");
    const row = rows.findIndex((l) => l.includes("Other agents"));
    expect(rows.slice(0, row).reverse().find((l) => /│ [A-Z][A-Z ]+\s+│/.test(l))).toMatch(/│ VISIBILITY\s+│/);
    for (let i = 0; i < 30 && !(await t.screen()).match(/› Other agents/); i++) {
      t.press(KEY.down);
      await sleep(20);
    }
    t.press(KEY.enter);
    await until(async () => c.calls.some((k) => k.method === "set" && k.params.visibility === "private"), 5_000, "made private");
    await seen("hidden from them");
  });

  it("picks an option with a click and answers with Enter, like its number key", async () => {
    const { t, c, seen } = await open();
    await seen("Merge the dependency fix?");
    const lines = (await t.screen()).split("\n");
    const y = lines.findIndex((l) => l.includes("2  Wait for 1.35"));
    // Beside the option, past its words: nothing.
    click(t, lines[y].indexOf("Wait for 1.35") + 30, y);
    await sleep(200);
    expect(await t.screen()).not.toContain("Enter to answer");
    click(t, lines[y].indexOf("2  Wait"), y);
    await seen("Enter to answer");
    await sleep(200);
    expect(c.calls.some((k) => k.method === "answer")).toBe(false);
    t.press(KEY.enter);
    await until(async () => c.calls.some((k) => k.method === "answer" && k.params.choice === 2), 5_000, "answered with Enter");
  });

  it("keeps the options and Dismiss in view when it opens on a question taller than the screen", async () => {
    const c = new FakeClient();
    const q = c.data.messages["repo-keeper"].find((m: any) => m.id === "m5");
    q.text += "\n\n" + Array.from({ length: 30 }, (_, i) => `Detail ${i} about the bump.`).join("\n\n");
    const { t, seen } = await open(120, 30, c);
    await seen("Dismiss this question");
    const s = await t.screen();
    expect(s).toContain("1  Merge it");
    expect(s).toContain("3  Close it");
  });

  it("copies only the words you selected in the conversation: no agent list, divider or message bars", async () => {
    const { t, tui, seen } = await open();
    await seen("Merge the dependency fix?");
    const lines = (await t.screen()).split("\n");
    const y = lines.findIndex((l) => l.includes("Dependabot opened"));
    const x = lines[y].indexOf("Dependabot");
    // From the question's first word, down two rows and back over into the agent list.
    t.press(`\x1b[<0;${x + 1};${y + 1}M`);
    t.press(`\x1b[<32;${x + 61};${y + 2}M`);
    t.press(`\x1b[<32;${4};${y + 3}M`);
    t.press(`\x1b[<32;${x + 61};${y + 3}M`);
    await sleep(100);
    // What a release would copy (not released here: that would write this machine's clipboard).
    const text: string = (tui as any).getActiveSelectionText();
    expect(text.split("\n")[0]).toMatch(/^Dependabot opened #212/);
    expect(text.split("\n").length).toBe(3);
    expect(text).not.toMatch(/[│┃]/);
    for (const l of text.split("\n")) expect(l).not.toMatch(/^\s/);
    for (const name of ["repo-keeper", "game-builder", "inbox-triage", "scout", "old-bot", "New agent"]) expect(text).not.toContain(name);
    // What's highlighted on screen is what's copied: never the agent list beside it.
    expect((await t.cell(2, y + 1)).inverse).toBe(false);
    expect((await t.cell(x + 1, y + 1)).inverse).toBe(true);
  });

  it("copies only the agent list when the selection starts there", async () => {
    const { t, tui, seen } = await open();
    await seen("Merge the dependency fix?");
    const lines = (await t.screen()).split("\n");
    const y = lines.findIndex((l) => l.includes("  scout"));
    t.press(`\x1b[<0;2;${y + 1}M`);
    t.press(`\x1b[<32;100;${y + 2}M`);
    await sleep(100);
    const text: string = (tui as any).getActiveSelectionText();
    expect(text).toContain("scout");
    expect(text).toContain("waiting for its job");
    expect(text).not.toContain("│");
    expect(text.split("\n").every((l) => l.length <= 34)).toBe(true);
  });

  it("scrolls when you click the 'newer below' or 'lines above' hint, never acting on the line under it", async () => {
    const { t, c, seen } = await open(120, 22);
    await seen("newer below");
    let s = (await t.screen()).split("\n");
    click(t, 60, s.findIndex((l) => l.includes("newer below")));
    await until(async () => !(await t.screen()).includes("newer below"), 5_000, "at the newest");
    s = (await t.screen()).split("\n");
    const above = s.findIndex((l) => l.includes("lines above"));
    const before = s[above];
    click(t, 60, above);
    await until(async () => (await t.screen()).split("\n")[above] !== before, 5_000, "scrolled up");
    await sleep(200);
    expect(c.calls.some((k) => k.method === "answer" || k.method === "dismiss")).toBe(false);
  });

  it("keeps what you were writing with its agent when you move to another", async () => {
    const { t, c, seen } = await open();
    await seen("Merge the dependency fix?");
    t.type("delete the old branches");
    await seen("delete the old branches");
    t.press(KEY.down);
    await seen("Harbour blockout done");
    expect(await t.screen()).not.toContain("delete the old branches");
    t.press(KEY.enter);
    await sleep(200);
    expect(c.calls.some((k) => k.method === "send" || k.method === "answer")).toBe(false);
    t.press(KEY.up);
    await seen("delete the old branches");
  });

  it("moves the cursor with Home and End in the message box", async () => {
    const { t, app, seen } = await open();
    await seen("Merge the dependency fix?");
    t.type("abc");
    t.press("\x1b[H");
    t.type("X");
    t.press("\x1b[F");
    t.type("Y");
    await sleep(100);
    expect(app.input.getValue()).toBe("XabcY");
  });

  it("loads older messages once, keeps your place, and keeps them through a refresh", async () => {
    const c = new FakeClient();
    const older = Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, t: new Date(Date.now() - 9e8 + i * 1000).toISOString(), from: "agent", kind: "message", text: `older message ${i}` }));
    const newer = Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, t: new Date(Date.now() - 6e5 + i * 1000).toISOString(), from: "agent", kind: "message", text: `newer message ${i}` }));
    const call = c.call.bind(c);
    c.call = async (m: string, p: any) => {
      if (m === "messages" && p.name === "game-builder") {
        c.calls.push({ method: m, params: p });
        if (p.before) return await sleep(150), { messages: older, hasMore: false };
        return { messages: newer, hasMore: true };
      }
      return call(m, p);
    };
    const { t, app, seen } = await open(120, 36, c);
    await seen("Merge the dependency fix?");
    t.press(KEY.down);
    await seen("newer message 59");
    await sleep(100);
    // The wheel, up, to the top (steps past it while they load move on into them: see below).
    for (let i = 0; i < 100 && (app as any).scroll !== 0; i++) t.press("\x1b[<64;80;10M");
    await until(async () => app.messages[0]?.id === "o0", 5_000, "older loaded");
    await sleep(200);
    expect(c.calls.filter((k) => k.method === "messages" && k.params.before).length).toBe(1);
    expect(app.messages.map((m) => m.id)).toEqual([...older, ...newer].map((m) => m.id));
    // Still reading where you were: the oldest of the newer ones, with the older ones above it.
    const shown = await t.screen();
    expect(shown).toContain("newer message 0");
    expect(shown).toContain("lines above");
    await app.refresh();
    await sleep(100);
    expect(app.messages.map((m) => m.id)).toEqual([...older, ...newer].map((m) => m.id));
    expect(await t.screen()).toBe(shown);
  });

  it("keeps the settings selection on the same row when the rows above it change", async () => {
    const { t, c, seen } = await open();
    await seen("Merge the dependency fix?");
    t.press("\x1b[C"); // → settings
    await seen("CONTROL");
    for (let i = 0; i < 30 && !(await t.screen()).includes("› Stop"); i++) {
      t.press(KEY.down);
      await sleep(20);
    }
    expect(await t.screen()).toContain("› Stop");
    // A server above it goes away while the panel is open (removed elsewhere): Stop stays selected.
    c.data.mcp = c.data.mcp.filter((m: any) => m.name !== "github");
    c.emit({ type: "changed", agent: "repo-keeper", what: "agents" });
    await until(async () => !(await t.screen()).includes("github"), 5_000, "github gone");
    expect(await t.screen()).toContain("› Stop");
    // And one added: still Stop.
    c.data.mcp = [{ name: "linear", source: "person", enabled: true, describe: "linear" }, ...c.data.mcp];
    c.emit({ type: "changed", agent: "repo-keeper", what: "agents" });
    await seen("linear");
    expect(await t.screen()).toContain("› Stop");
    t.press(KEY.enter);
    await seen("Start");
    expect(c.calls.some((x) => x.method === "stop")).toBe(true);
    expect(await t.screen()).toContain("› Start"); // Stop became Start: the same row, still selected
    expect(await t.screen()).not.toContain("Archive repo-keeper?");
  });

  it("shows when a long message in the box has lines hidden above or below", async () => {
    // Bordered, on a tint, and short (no border): each says how much is out of view.
    for (const [rows, tint, shown] of [[36, false, 10], [36, true, 10], [14, false, 5]] as const) {
      style.resetPalette();
      if (tint) style.applyTerminalColors({ background: { r: 12, g: 12, b: 12 }, foreground: { r: 224, g: 224, b: 224 } }, true);
      const { t, seen } = await open(120, rows);
      await seen("▌ repo-keeper");
      for (let i = 1; i <= 15; i++) {
        if (i > 1) t.press("\n");
        t.type(`line ${i}`);
      }
      await seen("line 15");
      await seen(`↑ ${15 - shown} more`);
      for (let i = 0; i < 14; i++) t.press(KEY.up);
      await seen(`↓ ${15 - shown} more`);
      const s = await t.screen();
      expect(s).toContain("line 1 ");
      expect(s).not.toContain(`↑ ${15 - shown} more`);
      expect(s.split("\n").every((l) => l.length <= 120)).toBe(true);
    }
  });

  /** A client whose game-builder has `all` messages, served in pages of 300 like the daemon's. */
  function paged(all: any[], slow = 150) {
    const c = new FakeClient();
    const call = c.call.bind(c);
    c.call = async (m: string, p: any) => {
      if (m === "messages" && p.name === "game-builder") {
        c.calls.push({ method: m, params: p });
        const end = p.before ? all.findIndex((x) => x.id === p.before) : all.length;
        const start = Math.max(0, end - (p.limit ?? 300));
        if (p.before) await sleep(slow);
        return { messages: all.slice(start, end), hasMore: start > 0 };
      }
      return call(m, p);
    };
    return c;
  }
  const msgs = (prefix: string, n: number, from: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, t: new Date(Date.now() - from + i * 1000).toISOString(), from: "agent", kind: "message", text: `${prefix} message ${i}` }));

  it("applies wheel steps made while older messages load, once they're in", async () => {
    const all = [...msgs("old", 320, 9e8), ...msgs("new", 40, 6e5)];
    const c = paged(all);
    const { t, app, seen } = await open(120, 36, c);
    await seen("Merge the dependency fix?");
    t.press(KEY.down);
    await seen("new message 39");
    await sleep(100);
    const a = app as any;
    for (let i = 0; i < 2000 && a.scroll !== 0; i++) t.press("\x1b[<64;80;10M");
    expect(a.scroll).toBe(0);
    const before = a.msgLine.get(a.messages[0].id);
    const first = a.messages[0].id;
    // Two more steps (6 lines) while it loads: they aren't lost.
    t.press("\x1b[<64;80;10M");
    t.press("\x1b[<64;80;10M");
    await until(async () => app.messages.length > 300, 5_000, "older loaded");
    await sleep(100);
    expect(c.calls.filter((k) => k.method === "messages" && k.params.before).length).toBe(1);
    expect(a.scroll).toBe(a.msgLine.get(first) - before - 6);
  });

  it("keeps the older messages you loaded when more than a page of new ones arrives while you read", async () => {
    const all = [...msgs("old", 5, 9e8), ...msgs("new", 60, 6e5)];
    const c = paged(all);
    const { t, app, seen } = await open(120, 36, c);
    await seen("Merge the dependency fix?");
    t.press(KEY.down);
    await seen("new message 59");
    await sleep(100);
    for (let i = 0; i < 100 && (app as any).scroll !== 0; i++) t.press("\x1b[<64;80;10M");
    await until(async () => app.messages[0]?.id === "old0", 5_000, "older loaded");
    await sleep(200);
    const shown = await t.screen();
    // 400 new messages arrive: the latest page no longer reaches what you loaded.
    all.push(...msgs("more", 400, 1e5));
    await app.refresh();
    await sleep(100);
    expect(app.messages.map((m) => m.id)).toEqual(all.map((m) => m.id));
    expect(await t.screen()).toBe(shown);
  });

  it("never puts a panel's clicks on the message box or footer in a short terminal", async () => {
    const { t, app } = await open(100, 9);
    await sleep(300);
    t.press(KEY.tab);
    await sleep(300);
    // 9 rows: the message box (one row when short) and the footer are the last two.
    expect((app as any).hits.length).toBeGreaterThan(0);
    expect((app as any).hits.every((h: any) => h.row < 7)).toBe(true);
  });

  it("shows the agent is on what you just wrote, with its current step", async () => {
    const { t, app, seen } = await open();
    await seen("Merge the dependency fix?");
    t.press(KEY.down); // game-builder: no open question, so typing sends a message
    await seen("Harbour blockout done");
    t.type("how is the harbour going?");
    t.press(KEY.enter);
    await seen("how is the harbour going?");
    app.onLive({ agent: "game-builder", kind: "main", text: "", step: "Reading the build log", startedAt: new Date().toISOString() });
    await seen("Reading the build log");
    app.onLive({ agent: "game-builder", kind: "main", text: "", step: null, startedAt: "", done: true });
    await until(async () => !(await t.screen()).includes("Reading the build log"), 5_000, "indicator cleared");
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
    // repo-keeper has a question open, so what you type answers it.
    const sent = c.calls.find((x) => x.method === "send" || x.method === "answer");
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
    expect(c.calls.find((x) => x.method === "send" || x.method === "answer")?.params.text).toBe("one\ntwo");
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
