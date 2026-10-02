import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Input, Key, ProcessTerminal, TuiAltScreen, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Terminal } from "@earendil-works/pi-tui";
import { ensureDaemon, type DaemonClient } from "../daemon/client.js";
import type { AgentSummary } from "../daemon/control.js";
import type { ThreadEntry, ThreadMeta } from "../store/types.js";
import { validateName } from "../agent/agent.js";
import { paths } from "../paths.js";

// ---------- styling ----------
const esc = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const bold = esc("1");
const dim = esc("2");
const inv = esc("7");
const cyan = esc("36");
const green = esc("32");
const yellow = esc("33");
const red = esc("31");
const link = (target: string, label: string) => `\x1b]8;;${target}\x07${label}\x1b]8;;\x07`;

function fit(s: string, w: number): string {
  if (w <= 0) return "";
  const t = truncateToWidth(s, w);
  return t + " ".repeat(Math.max(0, w - visibleWidth(t)));
}

function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  if (m < 1) return "now";
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

function until(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = (new Date(iso).getTime() - Date.now()) / 60000;
  if (m <= 1) return "now";
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 1440) {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return new Date(iso).toLocaleDateString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * Text from agents is shown as text, never as terminal commands: escape sequences and other control
 * characters are removed, so an agent (or a web page it quoted) can't move the cursor, retitle the
 * window or plant hidden links.
 */
export function clean(s: string | null | undefined): string {
  return String(s ?? "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)?|\x1b.|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/** Every string in a daemon reply, cleaned. Names, titles, messages and links all come from agents. */
export function cleanDeep<T>(v: T): T {
  if (typeof v === "string") return clean(v) as T;
  if (Array.isArray(v)) return v.map(cleanDeep) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanDeep(x)])) as T;
  return v;
}

/** Extensions that run something when opened, rather than show it. */
const RUNNABLE = new Set([".app", ".command", ".tool", ".terminal", ".sh", ".bash", ".zsh", ".scpt", ".applescript", ".workflow", ".action", ".pkg", ".mpkg", ".dmg", ".jar", ".desktop", ".run", ".appimage", ".exe", ".bat", ".cmd", ".ps1", ".fileloc", ".webloc", ".inetloc"]);

/** What opening a link should actually do, decided before anything is launched. Exported for tests. */
export function openPlan(target: string): { args: string[]; note?: string } | { refuse: string } {
  const mac = process.platform === "darwin";
  let path: string | null = null;
  if (/^https?:\/\//i.test(target)) return { args: [target] };
  if (/^file:\/\//i.test(target)) {
    try {
      path = fileURLToPath(target);
    } catch {
      return { refuse: "That link isn't a valid file link." };
    }
  } else if (target.startsWith("/")) path = target;
  else return { refuse: "Only web links and files are opened." };
  let st;
  try {
    st = statSync(path);
  } catch {
    return { refuse: `There's nothing at ${path} any more.` };
  }
  if (st.isDirectory() && !RUNNABLE.has(extname(path).toLowerCase())) return { args: [path] };
  // Anything that would run (an app, a script, an executable) is shown in its folder instead.
  if (RUNNABLE.has(extname(path).toLowerCase()) || (st.mode & 0o111) !== 0) {
    return mac ? { args: ["-R", path], note: "Shown in Finder, not run." } : { args: [dirname(path)], note: "Opened its folder, not run." };
  }
  return { args: [path] };
}

function openTarget(target: string): string | undefined {
  const plan = openPlan(target);
  if ("refuse" in plan) return plan.refuse;
  execFile(process.platform === "darwin" ? "open" : "xdg-open", plan.args, () => {});
  return plan.note;
}

type Overlay = null | "new" | "search" | "help" | "behind";
type Pane = "agents" | "threads";

interface BehindItem {
  label: string;
  target?: string;
  note?: string;
}

/** The whole screen as one component: agents on the left, the conversation on the right. */
export class App implements Component {
  agents: AgentSummary[] = [];
  agentIdx = 0;
  pane: Pane = "agents";
  threads: ThreadMeta[] = [];
  threadIdx = 0;
  open: { meta: ThreadMeta; entries: ThreadEntry[] } | null = null;
  scroll = 0;
  linkIdx = -1;
  overlay: Overlay = null;
  flash = "";
  input = new Input({ prompt: "" });
  overlayInput = new Input({ prompt: "" });
  searchHits: { agent: string; thread: ThreadMeta }[] = [];
  searchIdx = 0;
  behind: BehindItem[] = [];
  behindIdx = 0;
  connected = true;
  private inflight: Promise<void> | null = null;
  private again = false;

  constructor(public c: DaemonClient, private readonly tui: TuiAltScreen, private readonly term: Terminal, private readonly onQuit: () => void, private readonly opener: (t: string) => string | void = openTarget) {}

  /** A read from the daemon, with everything agent-written made safe to print. */
  private async get<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return cleanDeep(await this.c.call<T>(method, params));
  }

  get agent(): AgentSummary | undefined {
    return this.agents[this.agentIdx];
  }

  invalidate(): void {}

  // ---------- data ----------

  /** Refresh from the daemon. Calls during a refresh wait for a fresh one, so callers always see current data. */
  refresh(): Promise<void> {
    if (this.inflight) {
      this.again = true;
      return this.inflight.then(() => (this.inflight ? this.inflight : undefined));
    }
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<void> {
    try {
      const prevName = this.agent?.name;
      this.agents = await this.get("agents");
      const idx = this.agents.findIndex((a) => a.name === prevName);
      this.agentIdx = idx >= 0 ? idx : Math.min(this.agentIdx, Math.max(0, this.agents.length - 1));
      if (this.agent) {
        const prevThread = this.threads[this.threadIdx]?.id;
        const fresh: ThreadMeta[] = await this.get("threads", { name: this.agent.name });
        const atEnd = this.threadIdx >= this.threads.length - 1;
        this.threads = fresh;
        const t = fresh.findIndex((x) => x.id === prevThread);
        this.threadIdx = t >= 0 && !(atEnd && this.agent.name === prevName) ? t : Math.max(0, fresh.length - 1);
        if (this.open) {
          const th = await this.get("thread", { name: this.agent.name, id: this.open.meta.id, markRead: true });
          const grew = th.entries.length > this.open.entries.length;
          this.open = th;
          if (grew) this.scroll = Number.MAX_SAFE_INTEGER;
        }
      } else {
        this.threads = [];
        this.open = null;
      }
      this.connected = true;
    } catch (e: any) {
      this.flash = String(e?.message ?? e);
      this.connected = false;
    } finally {
      this.tui.requestRender();
    }
  }

  private async openThread(meta: ThreadMeta): Promise<void> {
    if (!this.agent) return;
    this.open = await this.get("thread", { name: this.agent.name, id: meta.id, markRead: true });
    this.scroll = Number.MAX_SAFE_INTEGER;
    this.linkIdx = -1;
    this.pane = "threads";
    void this.refresh();
  }

  private say(msg: string): void {
    this.flash = msg;
    this.tui.requestRender();
    setTimeout(() => {
      if (this.flash === msg) {
        this.flash = "";
        this.tui.requestRender();
      }
    }, 5000);
  }

  // ---------- input ----------

  handleInput(data: string): void {
    void this.onKey(data).catch((e) => this.say(String(e?.message ?? e)));
  }

  private async onKey(data: string): Promise<void> {
    if (matchesKey(data, Key.ctrl("c"))) return this.quit();
    if (this.overlay) return this.overlayKey(data);

    const typing = this.input.getValue().length > 0;
    if (matchesKey(data, Key.ctrl("n"))) return this.showOverlay("new");
    if (matchesKey(data, Key.ctrl("f"))) return this.showOverlay("search");
    if (matchesKey(data, Key.ctrl("o"))) return this.showBehind();
    if (matchesKey(data, Key.ctrl("l"))) return this.nextLink();
    if (!typing && data === "?") return this.showOverlay("help");

    if (matchesKey(data, Key.escape)) {
      if (typing) this.input.setValue("");
      else if (this.open) {
        this.open = null;
        this.linkIdx = -1;
      } else this.pane = "agents";
      return this.tui.requestRender();
    }
    if (matchesKey(data, Key.tab)) {
      this.pane = this.pane === "agents" ? "threads" : "agents";
      return this.tui.requestRender();
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const d = matchesKey(data, Key.up) ? -1 : 1;
      if (this.open) this.scroll = Math.max(0, (this.scroll === Number.MAX_SAFE_INTEGER ? this.lastMaxScroll : this.scroll) + d);
      else if (this.pane === "agents") this.moveAgent(d);
      else this.threadIdx = Math.min(Math.max(0, this.threadIdx + d), Math.max(0, this.threads.length - 1));
      return this.tui.requestRender();
    }
    if (!typing && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
      if (matchesKey(data, Key.right) && !this.open && this.agent) this.pane = "threads";
      else if (matchesKey(data, Key.left)) {
        if (this.open) this.open = null;
        else this.pane = "agents";
      }
      return this.tui.requestRender();
    }
    if (!typing && /^[1-9]$/.test(data) && this.open && this.open.meta.status === "waiting_on_you") {
      // Only the question being asked now: its options are the latest thing the agent wrote.
      const q = [...this.open.entries].reverse().find((e) => e.from === "agent");
      const n = Number(data);
      if (q?.options?.length && n <= q.options.length) {
        await this.c.call("answer", { name: this.agent!.name, threadId: this.open.meta.id, choice: n });
        this.say(`Answered: ${clean(q.options[n - 1])}`);
        return this.refresh();
      }
    }
    if (matchesKey(data, Key.enter)) {
      if (typing) return this.submit();
      if (this.open && this.linkIdx >= 0) {
        const l = this.allLinks()[this.linkIdx];
        if (l) this.openLink(l.target);
        return;
      }
      if (this.pane === "agents") {
        if (this.agent) this.pane = "threads";
        else this.showOverlay("new");
        return this.tui.requestRender();
      }
      const t = this.threads[this.threadIdx];
      if (t) await this.openThread(t);
      return;
    }
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  private moveAgent(d: number): void {
    const n = Math.min(Math.max(0, this.agentIdx + d), Math.max(0, this.agents.length - 1));
    if (n !== this.agentIdx) {
      this.agentIdx = n;
      this.threads = [];
      this.threadIdx = 0;
      this.open = null;
      void this.refresh();
    }
  }

  private async submit(): Promise<void> {
    const text = this.input.getValue().trim();
    if (!text || !this.agent) {
      if (!this.agent) this.say("Create an agent first (Ctrl+N).");
      return;
    }
    this.input.setValue("");
    if (this.open) {
      if (this.open.meta.status === "waiting_on_you") await this.c.call("answer", { name: this.agent.name, threadId: this.open.meta.id, text });
      else await this.c.call("send", { name: this.agent.name, threadId: this.open.meta.id, text });
    } else {
      const r = await this.c.call("send", { name: this.agent.name, text });
      await this.refresh();
      const t = this.threads.find((x) => x.id === r.threadId);
      if (t) await this.openThread(t);
    }
    await this.refresh();
  }

  openLink(target: string): void {
    const note = this.opener(target);
    if (note) this.say(note);
  }

  private allLinks() {
    return (this.open?.entries ?? []).flatMap((e) => e.links ?? []);
  }

  private nextLink(): void {
    const n = this.allLinks().length;
    if (!this.open || !n) return this.say(this.open ? "No links in this thread." : "Open a thread first.");
    this.linkIdx = (this.linkIdx + 1) % n;
    this.tui.requestRender();
  }

  private showOverlay(o: Overlay): void {
    this.overlay = o;
    this.overlayInput.setValue("");
    this.searchHits = [];
    this.searchIdx = 0;
    this.tui.requestRender();
  }

  private async showBehind(): Promise<void> {
    if (!this.agent) return;
    const d = await this.get("agent", { name: this.agent.name });
    const items: BehindItem[] = [
      { label: "Agent folder", target: this.agent.dir },
      { label: "AGENT.md (who it is)", target: join(this.agent.dir, "AGENT.md") },
      { label: "INDEX.md (its map)", target: join(this.agent.dir, "INDEX.md") },
      { label: "Run transcripts (everything it was sent and did)", target: join(paths.meta(this.agent.name), "runs") },
    ];
    const s = d.schedule;
    items.push({ label: "Next wake", note: s.wakeAt ? `${new Date(s.wakeAt).toLocaleString()} — ${s.wakeReason ?? ""}` : "not set" });
    for (const l of s.loops) items.push({ label: `Every ${Math.round(l.everyMs / 60000)}m`, note: l.task });
    for (const m of d.monitors) items.push({ label: `Watch [${m.status}]`, note: `${m.why} — ${m.run}` });
    for (const h of d.helpers.slice(-8).reverse()) items.push({ label: `Helper ${h.status}`, note: h.task.split("\n")[0], target: h.workdir });
    for (const r of d.reports.slice(-6).reverse()) items.push({ label: `Report ${ago(r.t)} ago`, note: r.text.split("\n")[0] });
    this.behind = items;
    this.behindIdx = 0;
    this.overlay = "behind";
    this.tui.requestRender();
  }

  private async overlayKey(data: string): Promise<void> {
    if (matchesKey(data, Key.escape)) {
      this.overlay = null;
      return this.tui.requestRender();
    }
    if (this.overlay === "help") {
      this.overlay = null;
      return this.tui.requestRender();
    }
    if (this.overlay === "behind") {
      if (matchesKey(data, Key.up)) this.behindIdx = Math.max(0, this.behindIdx - 1);
      else if (matchesKey(data, Key.down)) this.behindIdx = Math.min(this.behind.length - 1, this.behindIdx + 1);
      else if (matchesKey(data, Key.enter)) {
        const it = this.behind[this.behindIdx];
        if (it?.target) this.openLink(it.target);
      }
      return this.tui.requestRender();
    }
    if (this.overlay === "search") {
      if (matchesKey(data, Key.up)) this.searchIdx = Math.max(0, this.searchIdx - 1);
      else if (matchesKey(data, Key.down)) this.searchIdx = Math.min(this.searchHits.length - 1, this.searchIdx + 1);
      else if (matchesKey(data, Key.enter)) {
        const hit = this.searchHits[this.searchIdx];
        if (hit) {
          this.overlay = null;
          this.agentIdx = Math.max(0, this.agents.findIndex((a) => a.name === hit.agent));
          await this.refresh();
          await this.openThread(hit.thread);
        }
      } else {
        this.overlayInput.handleInput(data);
        await this.runSearch(this.overlayInput.getValue());
      }
      return this.tui.requestRender();
    }
    if (this.overlay === "new") {
      if (matchesKey(data, Key.enter)) {
        const name = this.overlayInput.getValue().trim();
        const err = validateName(name);
        if (err) return this.say(err);
        await this.c.call("new", { name });
        this.overlay = null;
        await this.refresh();
        this.agentIdx = Math.max(0, this.agents.findIndex((a) => a.name === name));
        await this.refresh();
        const greet = this.threads[0];
        if (greet) await this.openThread(greet);
        return;
      }
      this.overlayInput.handleInput(data);
      return this.tui.requestRender();
    }
  }

  private async runSearch(q: string): Promise<void> {
    const needle = q.trim().toLowerCase();
    if (!needle) {
      this.searchHits = [];
      return;
    }
    const hits: { agent: string; thread: ThreadMeta }[] = [];
    for (const a of this.agents) {
      if (a.name.toLowerCase().includes(needle)) {
        const ths: ThreadMeta[] = await this.get("threads", { name: a.name });
        if (ths.at(-1)) hits.push({ agent: a.name, thread: ths.at(-1)! });
      }
      const ths: ThreadMeta[] = await this.get("threads", { name: a.name });
      for (const t of ths) if (t.title.toLowerCase().includes(needle)) hits.push({ agent: a.name, thread: t });
    }
    this.searchHits = hits.slice(-30).reverse();
    this.searchIdx = 0;
  }

  quit(): void {
    this.tui.stop();
    this.c.close();
    this.onQuit();
  }

  // ---------- rendering ----------

  private lastMaxScroll = 0;

  render(width: number): string[] {
    const rows = Math.max(4, this.term.rows);
    const bodyH = Math.max(1, rows - 3);
    // Narrow terminals show one pane at a time: the agent list, or the conversation.
    const narrow = width < 60;
    const leftW = narrow ? width : Math.min(34, Math.max(22, Math.floor(width * 0.3)));
    const rightW = narrow ? width : Math.max(1, width - leftW - 1);

    const waiting = this.agents.reduce((n, a) => n + a.waiting, 0);
    const head = ` ${bold("overtime")}  ${dim(`${this.agents.length} agent${this.agents.length === 1 ? "" : "s"}`)}${waiting ? "  " + yellow(`${waiting} waiting on you`) : ""}${this.connected ? "" : "  " + red("daemon not reachable")}`;
    const out: string[] = [fit(head, width)];

    const showLeft = !narrow || (!this.overlay && !this.open && this.pane === "agents");
    const showRight = !narrow || !showLeft;
    const left = showLeft ? this.renderAgents(leftW, bodyH) : [];
    const right = showRight ? (this.overlay ? this.renderOverlay(rightW, bodyH) : this.open ? this.renderThread(rightW, bodyH) : this.renderThreads(rightW, bodyH)) : [];
    for (let i = 0; i < bodyH; i++) {
      if (!narrow) out.push(fit(left[i] ?? "", leftW) + dim("│") + fit(right[i] ?? "", rightW));
      else out.push(fit((showLeft ? left[i] : right[i]) ?? "", width));
    }

    const target = this.overlay === "new" || this.overlay === "search" ? null : this.agent;
    const prompt = this.overlay === "new" ? "name" : this.overlay === "search" ? "search" : this.open ? (this.open.meta.status === "waiting_on_you" ? "answer" : "reply") : target ? `message ${target.name}` : "";
    const box = this.overlay === "new" || this.overlay === "search" ? this.overlayInput : this.input;
    const boxLine = box.render(Math.max(4, width - visibleWidth(clean(prompt)) - 4))[0] ?? "";
    out.push(fit(` ${cyan("❯")} ${dim(clean(prompt))} ${boxLine}`, width));
    out.push(fit(this.flash ? ` ${yellow(this.flash)}` : ` ${dim(this.hints())}`, width));
    return out;
  }

  private hints(): string {
    if (this.overlay === "new") return "type a name · Enter create · Esc cancel";
    if (this.overlay === "search") return "type to search · ↑↓ move · Enter open · Esc close";
    if (this.overlay === "behind") return "↑↓ move · Enter open · Esc close";
    if (this.overlay === "help") return "any key to close";
    if (this.open) {
      const q = this.open.meta.status === "waiting_on_you" ? "1-9 answer · " : "";
      return `${q}type to reply · ↑↓ scroll · Ctrl+L links · Enter open link · Ctrl+O behind · Esc back`;
    }
    if (this.pane === "agents") return "↑↓ agents · → threads · type to message · Ctrl+N new agent · Ctrl+F search · ? keys";
    return "↑↓ threads · Enter open · ← agents · type to start a thread · Ctrl+O behind · ? keys";
  }

  private renderAgents(w: number, h: number): string[] {
    const lines: string[] = [];
    lines.push(` ${cyan("+")} New agent ${dim("Ctrl+N")}`);
    lines.push("");
    const per = 2;
    const visible = Math.max(1, Math.floor((h - 2) / per));
    const start = Math.max(0, Math.min(this.agentIdx - Math.floor(visible / 2), this.agents.length - visible));
    this.agents.slice(start, start + visible).forEach((a, i) => {
      const idx = start + i;
      const sel = idx === this.agentIdx;
      const dot = a.status === "working" ? green("●") : a.status === "paused" || a.lastError ? yellow("◌") : a.status === "new" ? cyan("◍") : dim("○");
      const badgeN = a.waiting + a.unread;
      const badge = badgeN ? yellow(String(badgeN)) : "";
      const name = sel && this.pane === "agents" ? inv(` ${a.name} `) : sel ? bold(` ${a.name} `) : ` ${a.name} `;
      const top = `${sel ? cyan("▸") : " "}${dot}${name}`;
      lines.push(fit(top, w - 3) + " " + badge);
      const when =
        a.status === "paused" ? `paused · resumes ${until(a.pausedUntil)}` : a.status === "stopped" ? "stopped" : a.status === "new" ? "waiting for its job" : a.status === "working" ? a.activity || "working" : `${a.activity ? a.activity + " · " : ""}wakes ${until(a.nextWake)}`;
      lines.push(dim(`   ${when}`));
    });
    if (!this.agents.length) {
      lines.push(dim("   No agents yet."));
      lines.push(dim("   Press Ctrl+N to create one."));
    }
    return lines;
  }

  private renderThreads(w: number, h: number): string[] {
    const a = this.agent;
    if (!a) return ["", dim("  Create an agent with Ctrl+N. It starts with no identity;"), dim("  you tell it what it's for in its first conversation.")];
    const spend = a.costReported ? `$${a.spentUsd.toFixed(2)}/$${a.budgetUsd}` : `${Math.round(a.tokensToday / 1000)}k tokens`;
    const state = a.status === "working" ? green("● working") : a.status === "paused" ? yellow("◌ paused") : a.status === "new" ? cyan("◍ new") : dim(`○ ${a.status}`);
    const lines = [fit(` ${bold(a.name)}  ${state}  ${dim(spend)}  ${dim(a.backend + (a.model ? `/${a.model}` : ""))}`, w), dim(` ${a.activity || ""}`), dim(" " + "─".repeat(Math.max(0, w - 2)))];
    if (a.lastError) lines.push(yellow(` last error: ${a.lastError}`));
    const per = 2;
    const avail = Math.max(1, Math.floor((h - lines.length) / per));
    const start = Math.max(0, Math.min(this.threadIdx - avail + 1, this.threads.length - avail));
    if (!this.threads.length) lines.push(dim("  No threads yet. Type a message below."));
    this.threads.slice(start, start + avail).forEach((t, i) => {
      const idx = start + i;
      const sel = idx === this.threadIdx && this.pane === "threads";
      const icon = t.status === "waiting_on_you" ? yellow("?") : t.kind === "alert" ? red("!") : t.kind === "report" ? cyan("▪") : "›";
      const title = sel ? inv(` ${t.title} `) : ` ${t.title}`;
      const right = dim(ago(t.updatedAt));
      lines.push(fit(` ${icon}${title}`, w - 6) + " " + right);
      const sub = t.status === "waiting_on_you" ? yellow("   waiting on you") : t.unread ? cyan(`   ${t.unread} new`) : t.kind === "question" && t.status === "answered" ? dim("   answered") : "";
      lines.push(sub);
    });
    return lines;
  }

  private renderThread(w: number, h: number): string[] {
    const th = this.open!;
    const name = this.agent?.name ?? "";
    const header = [fit(` ${cyan("←")} ${bold(name)} ${dim("·")} ${th.meta.title}`, w), dim(" " + "─".repeat(Math.max(0, w - 2)))];
    const body: string[] = [];
    let linkN = 0;
    const wrap = (s: string, indent = "  ") => wrapTextWithAnsi(s, Math.max(10, w - indent.length - 1)).map((l) => indent + l);
    for (const e of th.entries) {
      const who = e.from === "you" ? bold("You") : e.from === "agent" ? cyan(bold(name)) : yellow(bold("Overtime"));
      body.push(` ${who} ${dim(new Date(e.t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }))}`);
      for (const para of e.text.split("\n")) body.push(...(para.trim() ? wrap(para) : [""]));
      if (e.why) body.push(...wrap(dim(`Why it matters: ${e.why}`)));
      if (e.recommendation) body.push(...wrap(`${bold("I'd recommend:")} ${e.recommendation}`));
      if (e.options?.length) e.options.forEach((o, i) => body.push(`   ${cyan(String(i + 1))}  ${o}`));
      for (const l of e.links ?? []) {
        const url = l.kind === "url" ? l.target : pathToFileURL(l.target).href;
        const label = `[${linkN + 1}] ${l.label}`;
        body.push(`   ${linkN === this.linkIdx ? inv(link(url, label)) : cyan(link(url, label))} ${dim(l.kind === "url" ? "↗" : l.kind)}`);
        linkN++;
      }
      body.push("");
    }
    const viewH = Math.max(1, h - header.length);
    const maxScroll = Math.max(0, body.length - viewH);
    this.lastMaxScroll = maxScroll;
    this.scroll = Math.min(this.scroll, maxScroll);
    return [...header, ...body.slice(this.scroll, this.scroll + viewH)];
  }

  private renderOverlay(w: number, h: number): string[] {
    const title = (t: string) => [fit(` ${bold(t)}`, w), dim(" " + "─".repeat(Math.max(0, w - 2)))];
    if (this.overlay === "new")
      return [...title("New agent"), "", "  Type its name below.", "", dim("  It starts with no identity. Tell it who it is and what it's for"), dim("  in the first chat; it writes that down and keeps it up to date.")];
    if (this.overlay === "help")
      return [
        ...title("Keys"),
        "  ↑ ↓          move through agents, threads, or scroll a thread",
        "  ← → / Tab    switch between agents and threads",
        "  Enter        open        Esc   back",
        "  just type    write a message; Enter sends",
        "  1-9          answer a question with that option",
        "  Ctrl+N       new agent   Ctrl+F  search",
        "  Ctrl+L       step through links in a thread; Enter opens",
        "  Ctrl+O       look further: folder, schedule, watches, helpers, transcripts",
        "  Ctrl+C       quit (your agents keep running)",
      ];
    if (this.overlay === "search") {
      const lines = title("Search");
      if (!this.searchHits.length) lines.push(dim(this.overlayInput.getValue() ? "  No matches." : "  Type to search agents and thread titles."));
      this.searchHits.slice(0, h - 3).forEach((s, i) => lines.push(fit(`${i === this.searchIdx ? cyan("▸") : " "} ${bold(s.agent)}  ${s.thread.title}  ${dim(ago(s.thread.updatedAt))}`, w)));
      return lines;
    }
    const lines = title(`Behind ${this.agent?.name ?? ""}`);
    this.behind.slice(0, h - 3).forEach((it, i) => {
      const sel = i === this.behindIdx;
      lines.push(fit(`${sel ? cyan("▸") : " "} ${it.target ? cyan(it.label) : bold(it.label)}${it.note ? dim("  " + it.note) : ""}`, w));
    });
    return lines;
  }
}

export interface AppOptions {
  terminal?: Terminal;
  client?: DaemonClient;
  onQuit?: () => void;
  /** How links and files are opened (tests replace this). Returns a note to show, if any. */
  opener?: (target: string) => string | void;
  /** How to reach the daemon again after it went away (default: start it if needed). */
  reconnect?: () => Promise<DaemonClient>;
}

export async function runApp(o: AppOptions = {}): Promise<{ app: App; tui: TuiAltScreen; stop: () => void }> {
  const connectFn = o.reconnect ?? ensureDaemon;
  const c = o.client ?? (await connectFn());
  const term = o.terminal ?? new ProcessTerminal();
  const opener = o.opener ?? openTarget;
  const tui = new TuiAltScreen(term, false, undefined, { openUrl: (url) => void app.openLink(url), copyOnSelect: true });
  let tick: NodeJS.Timeout | undefined;
  let quitting = false;
  const app = new App(c, tui, term, () => {
    quitting = true;
    if (tick) clearInterval(tick);
    (o.onQuit ?? (() => process.exit(0)))();
  }, opener);
  tui.addChild(app);
  tui.setFocus(app);
  tui.start();

  // If the daemon goes away (restarted, upgraded, crashed), keep the screen and reconnect when it's back.
  const attach = async (client: DaemonClient): Promise<void> => {
    app.c = client;
    await client.subscribe(() => void app.refresh());
    await app.refresh();
    void client.closed.then(async () => {
      if (quitting) return;
      app.connected = false;
      tui.requestRender();
      for (let wait = 1000; !quitting; wait = Math.min(wait * 2, 10_000)) {
        await new Promise((r) => setTimeout(r, wait));
        if (quitting) return;
        try {
          const next = await connectFn();
          if (quitting) return next.close();
          await attach(next);
          return;
        } catch {}
      }
    });
  };
  await attach(c);
  tick = setInterval(() => void app.refresh(), 15_000);
  return { app, tui, stop: () => app.quit() };
}
