// What the scripted demos (team, life) share: the real app, fed made-up agents through the fake daemon the
// tests use, and a few verbs for writing a scene on a timeline. No model runs; nothing is spent.
//
// Three things a real run has that a recording can't show are stood in for here, and only here:
// - The clock is set to the scene's own time (and runs faster), so the GIF reads the same whenever it's
//   recorded. Animations keep their real pace: the clock only ever jumps by whole beats of them.
// - Opening a file (Ctrl+L, Enter) shows it right in the terminal instead of in its app, so the recording
//   can see it; any key comes back.
// - The notifications Overtime would send (a question; a report) are written to $DEMO_NOTIFY_LOG with the
//   moment they'd pop, for notify-overlay.sh to draw onto the video. Ctrl+G marks the video's start.
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { markdownLines, runApp } from "../../src/tui/app.js";
import { accent, bold, faint, muted } from "../../src/tui/style.js";
import { FakeClient, fakeData } from "../../test/tui-fake.js";

// ---------- the scene's clock ----------

const RealDate = Date;
let offset = 0;
class SceneDate extends RealDate {
  constructor(...a: any[]) {
    if (a.length) super(...(a as [any]));
    else super(RealDate.now() + offset);
  }
  static now() {
    return RealDate.now() + offset;
  }
}
globalThis.Date = SceneDate as DateConstructor;

// The working circle turns every 200 ms and needs-you pulses every 1.6 s: moving the clock by whole
// multiples of 1.6 s never shows as a skip.
const BEAT = 1600;
let tick: NodeJS.Timeout | undefined;
/** Set the clock to a time of day, `days` from today. */
export function setClock(hour: number, minute = 0, days = 0) {
  const t = new RealDate();
  t.setDate(t.getDate() + days);
  t.setHours(hour, minute, 0, 0);
  offset = Math.round((t.getTime() - RealDate.now()) / BEAT) * BEAT;
}
/** Run the clock `times` faster than real time (1 stops the fast-forward). */
export function clockSpeed(times: number) {
  clearInterval(tick);
  if (times <= 1) return;
  // Each real 0.8 s, move on by whole beats: about `times` faster.
  const step = Math.max(1, Math.round((800 * (times - 1)) / BEAT)) * BEAT;
  tick = setInterval(() => (offset += step), 800);
}
export const at = (hour: number, minute = 0, days = 0) => {
  const t = new Date();
  t.setDate(t.getDate() + days);
  t.setHours(hour, minute, 0, 0);
  return t.toISOString();
};

// ---------- the scene ----------

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const until = async (ok: () => boolean) => {
  while (!ok()) await sleep(150);
};

export interface AgentSeed {
  name: string;
  ownStatus?: string;
  nextWake?: string | null;
  spentUsd?: number;
  budgetUsd?: number;
}

export async function scene(seeds: AgentSeed[], o: { home: string; files: string }) {
  const base = fakeData();
  const d: any = {
    agents: seeds.map((s) => ({ ...base.agents[0], status: "asleep", activity: "", ownStatus: "", waiting: 0, unread: 0, helpersRunning: 0, spentUsd: 0, budgetUsd: 20, model: null, lastError: null, nextWake: null, dir: `${o.home}/${s.name}`, ...s })),
    messages: Object.fromEntries(seeds.map((s) => [s.name, [] as any[]])),
    settings: {} as Record<string, any>,
    mcp: base.mcp,
  };
  for (const a of d.agents) d.settings[a.name] = { ...base.settings["repo-keeper"], dailyBudgetUsd: a.budgetUsd, workspace: a.dir, spentUsd: a.spentUsd };

  const agent = (name: string) => d.agents.find((a: any) => a.name === name)!;
  let seq = 0;
  const id = () => `s${++seq}`;

  // When the video starts (Ctrl+G from the tape), and the notifications since, in seconds from then.
  let videoStart = 0;
  const log = process.env.DEMO_NOTIFY_LOG;
  if (log) writeFileSync(log, "");
  const notify = (title: string, body: string) => {
    if (!log || !videoStart) return;
    appendFileSync(log, JSON.stringify({ t: (RealDate.now() - videoStart) / 1000, title, body: body.replace(/\s+/g, " ").slice(0, 200) }) + "\n");
  };

  class SceneClient extends FakeClient {
    async call(method: string, params: any = {}): Promise<any> {
      // Reading a conversation reads its new messages, as with the real daemon.
      if (method === "messages" && params.markRead) {
        const a = agent(params.name);
        if (a?.unread) {
          a.unread = 0;
          // The list was read before this; draw it again without the count.
          setTimeout(() => this.emit({ event: "agents" }), 50);
        }
      }
      if (method === "skills") return [];
      if (method === "agent") return { schedule: { wakeAt: agent(params.name)?.nextWake, wakeReason: "", loops: [] }, monitors: [], helpers: [] };
      const r = await super.call(method, params);
      // Your answer shows in the conversation under the question, as the daemon writes it.
      if (method === "answer" && params.choice) {
        const q = d.messages[params.name].find((m: any) => m.id === params.questionId);
        d.messages[params.name].push({ id: id(), t: new Date().toISOString(), from: "you", kind: "message", text: q.options[params.choice - 1], replyTo: q.id });
      }
      return r;
    }
  }

  process.env.OVERTIME_NO_NOTIFY = "1";
  const client = new SceneClient(d);

  // Files open in the terminal, so the recording can see them.
  let viewing = false;
  let tui: any;
  const opener = (target: string) => {
    if (!existsSync(target)) return;
    viewing = true;
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 30;
    const head = ` ${accent("▣")} ${bold(basename(target))}`;
    process.stdout.write("\x1b[2J\x1b[H\n" + head + "\n" + faint("─".repeat(cols)) + "\n" + view(target, cols - 4, rows - 6).map((l) => "  " + l).join("\n"));
    process.stdout.write(`\x1b[${rows};1H ${muted("any key goes back to Overtime")}`);
  };
  const { app, tui: t } = await runApp({ client: client as any, opener, onQuit: () => process.exit(0) });
  tui = t;
  const render = tui.doRender.bind(tui);
  tui.doRender = () => {
    if (!viewing) render();
  };
  const keys = app.handleInput.bind(app);
  app.handleInput = (data: string) => {
    if (data === "\x07") {
      videoStart = RealDate.now();
      return;
    }
    if (viewing) {
      viewing = false;
      process.stdout.write("\x1b[2J\x1b[H");
      return tui.requestRender(true);
    }
    keys(data);
  };
  process.on("SIGINT", () => process.exit(0));

  const changed = () => client.emit({ event: "agents" });
  const started: Record<string, string> = {};
  const step = (name: string, text: string | null) => {
    if (text === null) {
      if (started[name]) client.emit({ event: "live", agent: name, kind: "main", text: "", step: null, startedAt: started[name], done: true });
      delete started[name];
      return;
    }
    started[name] ??= new Date().toISOString();
    client.emit({ event: "live", agent: name, kind: "main", text: "", step: text, startedAt: started[name] });
  };
  /** A file the agent made, from the demo's files/, shown as it would be: name, kind, size. */
  const file = (name: string) => {
    const path = join(o.files, name);
    return { name, path, kind: /\.(png|jpe?g|gif)$/i.test(name) ? "image" : "file", bytes: statSync(path).size };
  };

  return {
    d,
    client,
    agent,
    changed,
    step,
    file,
    /** Something already in its conversation before the scene starts. */
    seed(name: string, m: any) {
      d.messages[name].push({ id: id(), from: "agent", kind: "message", ...m });
    },
    /** The agent says something to you. */
    say(name: string, text: string, extra: any = {}) {
      d.messages[name].push({ id: id(), t: new Date().toISOString(), from: "agent", kind: "message", text, ...extra });
    },
    /** Finished work: a report, which notifies and counts as unread until you read it. */
    report(name: string, title: string, body: string, extra: any = {}) {
      d.messages[name].push({ id: id(), t: new Date().toISOString(), from: "agent", kind: "report", title, text: `${title}\n${body}`, ...extra });
      agent(name).unread += 1;
      notify(name, title);
    },
    /** A question for you; it waits on your answer and notifies. */
    ask(name: string, q: { title: string; body: string; why?: string; recommendation?: string; options: string[] }) {
      d.messages[name].push({ id: id(), t: new Date().toISOString(), from: "agent", kind: "question", text: `${q.title}\n${q.body}`, why: q.why, recommendation: q.recommendation, options: q.options });
      Object.assign(agent(name), { status: "asleep", waiting: 1 });
      step(name, null);
      notify(`${name} has a question`, `${q.title} ${q.body}`);
    },
    answered: (name: string) => d.messages[name].some((m: any) => m.kind === "question" && m.answer),
    /** Wait for you to send `name` a message (beyond the `n` already there); returns its text. */
    async heard(name: string, n = 0): Promise<string> {
      const mine = () => d.messages[name].filter((m: any) => m.from === "you" && !m.replyTo);
      await until(() => mine().length > n);
      return mine().at(-1).text;
    },
    /** One agent messages another: it shows in both their conversations. */
    tell(from: string, to: string, text: string) {
      const m = { t: new Date().toISOString(), from: "agent", kind: "agent-message", fromAgent: from, toAgent: to, text };
      d.messages[from].push({ ...m, id: id() });
      d.messages[to].push({ ...m, id: id() });
    },
    /** An agent starts a turn: working, with what it says it's on and how many helpers it has out. */
    work(name: string, ownStatus: string, s: string, helpers = 0) {
      Object.assign(agent(name), { status: "working", ownStatus, helpersRunning: helpers, waiting: 0 });
      step(name, s);
    },
    /** Its own session hands the work to helpers and waits: the agent shows as working, with how many. */
    delegate(name: string, ownStatus: string, helpers: number) {
      Object.assign(agent(name), { status: "asleep", ownStatus, helpersRunning: helpers });
      step(name, null);
    },
    /** It finishes and goes back to sleep until its next wake. */
    rest(name: string, ownStatus: string, nextWake: string) {
      Object.assign(agent(name), { status: "asleep", ownStatus, helpersRunning: 0, nextWake, waiting: 0 });
      step(name, null);
    },
  };
}

// ---------- the in-terminal viewer ----------

/** A file as text for the terminal: Markdown rendered as the app renders messages, an image from its
 *  pre-drawn .ansi (half-blocks; files.py makes them), a PDF from the .md it was made from. */
function view(path: string, w: number, h: number): string[] {
  const ext = extname(path).toLowerCase();
  const twin = (e: string) => path.slice(0, -ext.length) + e;
  if ((ext === ".png" || ext === ".jpg") && existsSync(twin(".ansi"))) return readFileSync(twin(".ansi"), "utf8").replace(/\n$/, "").split("\n").slice(0, h);
  const md = ext === ".md" ? path : ext === ".pdf" && existsSync(twin(".md")) ? twin(".md") : null;
  if (md) return markdownLines(readFileSync(md, "utf8"), Math.min(w, 100)).slice(0, h);
  return [muted(path)];
}
