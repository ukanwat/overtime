/** A headless terminal and a scripted daemon client, for testing and previewing the app without a daemon. */
import xterm from "@xterm/headless";

export class TestTerminal {
  term: any;
  private onInput: (d: string) => void = () => {};
  constructor(
    public cols = 120,
    public rowsN = 36,
  ) {
    this.term = new xterm.Terminal({ cols, rows: rowsN, allowProposedApi: true });
  }
  start(onInput: (d: string) => void) {
    this.onInput = onInput;
  }
  stop() {}
  async drainInput() {}
  write(d: string) {
    this.raw += d;
    this.term.write(d);
  }
  raw = "";
  get columns() {
    return this.cols;
  }
  get rows() {
    return this.rowsN;
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
  /** The cell at (x, y): its text and colours, for checking styling. */
  async cell(x: number, y: number) {
    await new Promise<void>((r) => this.term.write("", r));
    const c = this.term.buffer.active.getLine(this.term.buffer.active.viewportY + y)?.getCell(x);
    return { ch: c?.getChars(), fg: c?.getFgColor(), fgMode: c?.getFgColorMode(), bg: c?.getBgColor(), bgMode: c?.getBgColorMode(), inverse: !!c?.isInverse(), bold: !!c?.isBold(), dim: !!c?.isDim() };
  }
}

const now = Date.now();
const iso = (minAgo: number) => new Date(now - minAgo * 60000).toISOString();
const home = "/Users/me/overtime/agents";

export function fakeData() {
  const summary = (name: string, o: any) => ({ name, status: "asleep", activity: "", nextWake: null, pausedUntil: null, waiting: 0, unread: 0, helpersRunning: 0, spentUsd: 0, costReported: true, tokensToday: 0, budgetUsd: 10, backend: "claude", model: null, lastError: null, dir: `${home}/${name}`, ...o });
  const agents: any[] = [
    summary("repo-keeper", { status: "asleep", activity: "CI green; watching the dependency PR", nextWake: new Date(now + 95 * 60000).toISOString(), waiting: 1, unread: 1, spentUsd: 1.2 }),
    summary("game-builder", { status: "working", activity: "lighting the harbour district", spentUsd: 6.41, budgetUsd: 50, helpersRunning: 2, model: "opus" }),
    summary("inbox-triage", { status: "paused", activity: "paused: daily budget used", pausedUntil: new Date(now + 9 * 60 * 60000).toISOString(), spentUsd: 10.02 }),
    summary("scout", { status: "new", activity: "waiting for its job", unread: 1, costReported: false }),
    summary("old-bot", { status: "stopped", activity: "stopped" }),
  ];
  const messages: Record<string, any[]> = {
    "repo-keeper": [
      { id: "m1", t: iso(3000), from: "agent", kind: "message", text: "Hi, I'm repo-keeper. I don't have a job yet. What should I be looking after, and is there anything I should always check with you first?" },
      { id: "m2", t: iso(2900), from: "you", kind: "message", text: "Your job: keep ukanwat/overtime healthy. Watch CI, keep deps current, and tell me before anything is published." },
      { id: "m3", t: iso(2899), from: "agent", kind: "message", text: `Got it. I'll watch CI on main every hour, review dependency PRs, and ask before merging anything that ships. Notes are in ${home}/repo-keeper/notes.md.`, links: [{ kind: "file", target: `${home}/repo-keeper/notes.md`, label: `${home}/repo-keeper/notes.md` }] },
      { id: "m4", t: iso(120), from: "agent", kind: "report", title: "CI is green again on main", text: "CI is green again on main\nThe flaky tui test was a timing race; fixed in 3f2a1c and it passed 20 runs in a row.", attachments: [{ name: "ci-runs.png", path: `${home}/repo-keeper/files/ci-runs.png`, kind: "image", bytes: 48211 }] },
      { id: "m5", t: iso(30), from: "agent", kind: "question", title: "Merge the dependency fix?", text: "Dependabot opened #212 bumping @modelcontextprotocol/sdk from 1.32 to 1.34. Tests pass on all CI jobs and the changelog has no breaking changes for what we use.", why: "It's a dependency of the published package, so a bad bump reaches every user.", recommendation: "Merge it now and cut 0.2.2 tomorrow with the other fixes.", options: ["Merge it", "Wait for 1.35", "Close it"], links: [{ kind: "url", target: "https://github.com/ukanwat/overtime/pull/212", label: "github.com/ukanwat/overtime/pull/212" }] },
      { id: "m6", t: iso(10), from: "overtime", kind: "alert", title: "Something keeps failing", text: "repo-keeper's last 3 turns failed. Latest error: the claude backend stopped (exit 1).\nOvertime keeps retrying with longer gaps." },
    ],
    "game-builder": [
      { id: "g1", t: iso(200), from: "you", kind: "message", text: "Build an open-world city in ~/AgentCity. Start with the harbour." },
      { id: "g2", t: iso(60), from: "agent", kind: "report", title: "Harbour blockout done", text: "Harbour blockout done\nDocks, warehouses and the lighthouse are placed. Two helpers are lighting it now." },
      { id: "g3", t: iso(50), from: "agent", kind: "question", title: "Night or dusk for the first screenshots?", text: "Night or dusk for the first screenshots?", options: ["Night", "Dusk"], answer: { choice: 2, text: "Dusk", t: iso(45) } },
      { id: "g4", t: iso(45), from: "you", kind: "message", text: "Dusk", replyTo: "g3" },
    ],
    "inbox-triage": [{ id: "b1", t: iso(200), from: "overtime", kind: "alert", title: "Daily budget used", text: "inbox-triage has used $10.02 today (budget $10.00). It resumes tomorrow. Raise the daily budget in its settings (Tab) to keep it going." }],
    scout: [{ id: "s1", t: iso(1), from: "agent", kind: "message", text: "Hi, I'm scout. I don't have a job yet. What should I be looking after, and is there anything I should always check with you first?" }],
    "old-bot": [],
  };
  const settings: Record<string, any> = {};
  for (const a of agents) settings[a.name] = { backend: a.backend, model: a.model, dailyBudgetUsd: a.budgetUsd, dailyTokenBudget: null, workspace: a.dir, workspaceIsDefault: true, spentUsd: a.spentUsd, costReported: a.costReported, tokensToday: 120000 };
  return { agents, messages, settings };
}

export class FakeClient {
  calls: { method: string; params: any }[] = [];
  isClosed = false;
  closed = new Promise<void>(() => {});
  listeners: ((e: any) => void)[] = [];
  constructor(public data = fakeData()) {}
  async subscribe(fn: (e: any) => void) {
    this.listeners.push(fn);
  }
  emit(e: any) {
    for (const l of this.listeners) l(e);
  }
  close() {}
  async call(method: string, params: any = {}): Promise<any> {
    this.calls.push({ method, params });
    const d = this.data;
    switch (method) {
      case "agents":
        return d.agents;
      case "messages":
        return { messages: d.messages[params.name] ?? [], hasMore: false };
      case "settings":
        return d.settings[params.name];
      case "agent":
        return { schedule: { wakeAt: new Date(now + 95 * 60000).toISOString(), wakeReason: "hourly CI check", loops: [] }, monitors: [], helpers: [] };
      case "backendStatus":
        return [{ name: "claude", missing: null }, { name: "codex", missing: null }, { name: "gemini", missing: "gemini isn't installed. Install Gemini CLI: npm install -g @google/gemini-cli" }, { name: "opencode", missing: null }];
      case "backends":
        return ["claude", "codex", "gemini"];
      case "models":
        return [
          { id: "default", name: "Default (recommended)" },
          { id: "opus", name: "Opus" },
          { id: "haiku", name: "Haiku" },
        ];
      case "live":
        return [];
      case "send": {
        const m = { id: `m${Math.random()}`, t: new Date().toISOString(), from: "you", kind: "message", text: params.text, attachments: (params.attachments ?? []).map((p: string) => ({ name: p.split("/").pop(), path: p, kind: "file", bytes: 10 })) };
        (d.messages[params.name] ??= []).push(m);
        return { id: m.id };
      }
      case "answer": {
        const q = (d.messages[params.name] ?? []).find((m: any) => m.id === params.questionId);
        if (q) q.answer = { choice: params.choice, text: params.choice ? q.options[params.choice - 1] : params.text, t: new Date().toISOString() };
        const a = d.agents.find((x: any) => x.name === params.name);
        if (a) a.waiting = 0;
        return { ok: true };
      }
      case "set": {
        const s = d.settings[params.name];
        for (const [k, v] of Object.entries(params)) if (k !== "name") s[k] = v;
        const a = d.agents.find((x: any) => x.name === params.name);
        if (a && params.dailyBudgetUsd !== undefined) a.budgetUsd = params.dailyBudgetUsd;
        if (a && params.backend) a.backend = params.backend;
        if (a && params.model !== undefined) a.model = params.model;
        return { ok: true };
      }
      case "new": {
        d.agents.push({ name: params.name, status: "new", activity: "waiting for its job", nextWake: null, pausedUntil: null, waiting: 0, unread: 1, helpersRunning: 0, spentUsd: 0, costReported: true, tokensToday: 0, budgetUsd: 10, backend: "claude", model: null, lastError: null, dir: `${home}/${params.name}` });
        d.messages[params.name] = [{ id: "n1", t: new Date().toISOString(), from: "agent", kind: "message", text: `Hi, I'm ${params.name}. I don't have a job yet.` }];
        d.settings[params.name] = { backend: "claude", model: null, dailyBudgetUsd: 10, dailyTokenBudget: null, workspace: `${home}/${params.name}`, workspaceIsDefault: true, spentUsd: 0, costReported: true, tokensToday: 0 };
        return { name: params.name };
      }
      case "stop":
      case "start": {
        const a = d.agents.find((x: any) => x.name === params.name);
        if (a) a.status = method === "stop" ? "stopped" : "asleep";
        return { ok: true };
      }
      default:
        return { ok: true };
    }
  }
}
