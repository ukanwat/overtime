import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Input, Key, ProcessTerminal, TuiAltScreen, matchesKey, visibleWidth, wrapTextWithAnsi, type Component, type Terminal, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { ensureDaemon, type DaemonClient } from "../daemon/client.js";
import type { AgentSummary } from "../daemon/control.js";
import type { ThreadEntry, ThreadMeta } from "../store/types.js";
import { validateName } from "../agent/agent.js";
import { paths } from "../paths.js";
import { accent, ago, bold, box, cleanDeep, dim, fit, friendly, gray, green, inverse, italic, link, money, openTarget, red, rule, selectedBg, spread, stamp, statusParts, underline, when, yellow } from "./style.js";

export { clean, cleanDeep, openPlan } from "./style.js";

/** A session that is running right now, streamed from the daemon (text so far, current step). */
export interface LiveState {
  agent: string;
  kind: "main" | "chat" | "helper";
  threadId?: string;
  helperId?: string;
  text: string;
  step: string | null;
  startedAt: string;
  done?: boolean;
}

type Focus = "agents" | "threads" | "thread";

interface ListItem {
  label: string;
  note?: string;
  key?: string;
  target?: string;
  run?: () => void | Promise<void>;
  /** A heading row, not selectable. */
  heading?: boolean;
  /** A plain line of explanation, not selectable. */
  info?: boolean;
  current?: boolean;
}

type Overlay =
  | null
  | { kind: "new"; error?: string }
  | { kind: "search"; hits: { agent: string; thread: ThreadMeta }[]; idx: number }
  | { kind: "help" }
  | { kind: "list"; title: string; items: ListItem[]; idx: number; hint?: string; loading?: string }
  | { kind: "confirm"; title: string; body: string[]; yes: string; run: () => Promise<void> };

/** A clickable area recorded while drawing, so mouse clicks map back to what was under them. */
interface Hit {
  row: number;
  x0: number;
  x1: number;
  act: () => void | Promise<void>;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const spinner = () => SPINNER[Math.floor(Date.now() / 90) % SPINNER.length];
/** Below this width the app shows one pane at a time. */
const NARROW = 84;
const PAGE = 10;
const HEADER_ROWS = 2;

const key = (k: string, label: string) => `${bold(k)} ${gray(label)}`;

/** The whole screen as one component: agents on the left, the conversation on the right, a composer below. */
export class App implements Component {
  agents: AgentSummary[] = [];
  agentIdx = 0;
  focus: Focus = "agents";
  threads: ThreadMeta[] = [];
  threadIdx = 0;
  open: { meta: ThreadMeta; entries: ThreadEntry[] } | null = null;
  scroll = Number.MAX_SAFE_INTEGER;
  linkIdx = -1;
  overlay: Overlay = null;
  flash: { text: string; tone: "ok" | "err" | "info" } | null = null;
  input = new Input({ prompt: "", placeholderStyle: gray });
  overlayInput = new Input({ prompt: "", placeholderStyle: gray });
  connected = true;
  live = new Map<string, LiveState>();
  private hits: Hit[] = [];
  private inflight: Promise<void> | null = null;
  private again = false;
  private flashTimer: NodeJS.Timeout | null = null;
  private lastMaxScroll = 0;
  /** Where the open thread's view actually started on the last draw. */
  private lastShown = 0;
  /** Width of the agent list on the last draw (0 when it isn't shown beside the conversation). */
  private leftW = 0;

  constructor(public c: DaemonClient, private readonly tui: TuiAltScreen, private readonly term: Terminal, private readonly onQuit: () => void, private readonly opener: (t: string) => string | void = openTarget) {}

  get agent(): AgentSummary | undefined {
    return this.agents[this.agentIdx];
  }

  invalidate(): void {}

  // ---------- data ----------

  /** A read from the daemon, with everything agent-written made safe to print. */
  private async get<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return cleanDeep(await this.c.call<T>(method, params));
  }

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
        const prevThread = this.visibleThreads()[this.threadIdx]?.id;
        this.threads = await this.get("threads", { name: this.agent.name });
        const t = this.visibleThreads().findIndex((x) => x.id === prevThread);
        this.threadIdx = t >= 0 && this.agent.name === prevName ? t : 0;
        if (this.open) {
          const th = await this.get("thread", { name: this.agent.name, id: this.open.meta.id, markRead: true });
          const grew = th.entries.length > this.open.entries.length;
          this.open = th;
          if (grew) this.scroll = Number.MAX_SAFE_INTEGER;
        }
      } else {
        this.threads = [];
        this.open = null;
        this.focus = "agents";
      }
      if (!this.connected) this.say("Reconnected.", "ok");
      this.connected = true;
    } catch (e) {
      const lost = /disconnected|ECONNREFUSED|ENOENT|EPIPE/.test(String((e as any)?.message ?? e));
      if (lost) this.connected = false;
      else this.say(friendly(e), "err");
    } finally {
      this.tui.requestRender();
    }
  }

  /** Threads in the order shown: needing you first, then newest first, closed last. */
  visibleThreads(): ThreadMeta[] {
    const rank = (t: ThreadMeta) => (t.status === "waiting_on_you" ? 0 : t.status === "closed" ? 2 : 1);
    return [...this.threads].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Streamed progress from a running session. */
  onLive(e: LiveState): void {
    const k = `${e.agent}/${e.kind}/${e.threadId ?? e.helperId ?? ""}`;
    if (e.done) this.live.delete(k);
    else this.live.set(k, cleanDeep(e));
    this.tui.requestRender();
  }

  setLive(all: LiveState[]): void {
    this.live.clear();
    for (const e of all ?? []) this.onLive({ ...e, done: false });
  }

  private mainLive(agent: string): LiveState | undefined {
    return this.live.get(`${agent}/main/`);
  }

  private chatLive(agent: string, threadId: string): LiveState | undefined {
    return this.live.get(`${agent}/chat/${threadId}`);
  }

  private async openThread(meta: ThreadMeta): Promise<void> {
    if (!this.agent) return;
    this.open = await this.get("thread", { name: this.agent.name, id: meta.id, markRead: true });
    this.scroll = Number.MAX_SAFE_INTEGER;
    this.linkIdx = -1;
    this.focus = "thread";
    void this.refresh();
  }

  say(text: string, tone: "ok" | "err" | "info" = "info"): void {
    this.flash = { text, tone };
    this.tui.requestRender();
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flash = null;
      this.tui.requestRender();
    }, tone === "err" ? 8000 : 4000);
    this.flashTimer.unref?.();
  }

  // ---------- input ----------

  handleInput(data: string): void {
    void this.onKey(data).catch((e) => this.say(friendly(e), "err"));
  }

  handleMouse(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (ev.type === "wheel") {
      // The wheel acts on the pane under the pointer.
      const d = (ev.wheelDelta ?? 0) > 0 ? 1 : -1;
      const overLeft = this.leftW > 0 && ev.screenX < this.leftW;
      if (overLeft) this.moveAgent(d);
      else if (this.focus === "thread" && this.open) this.scrollBy(d * 3);
      else if (this.agent && !this.overlay) this.moveThread(d);
      return { handled: true };
    }
    if (ev.type !== "click" || ev.button !== "left") return undefined;
    const hit = this.hits.find((h) => h.row === ev.screenY && ev.screenX >= h.x0 && ev.screenX < h.x1);
    if (!hit) return undefined;
    void Promise.resolve(hit.act()).catch((e) => this.say(friendly(e), "err"));
    return { handled: true };
  }

  private typing(): boolean {
    return this.input.getValue().length > 0;
  }

  private async onKey(data: string): Promise<void> {
    if (matchesKey(data, Key.ctrl("c"))) return this.quit();
    if (this.overlay) return this.overlayKey(data);

    if (matchesKey(data, Key.ctrl("n"))) return this.showNew();
    if (matchesKey(data, Key.ctrl("f"))) return this.showSearch();
    if (matchesKey(data, Key.ctrl("p"))) return this.showActions();
    if (matchesKey(data, Key.ctrl("o"))) return this.showBehind();
    if (matchesKey(data, Key.ctrl("r"))) return this.wake();
    if (matchesKey(data, Key.ctrl("s"))) return this.toggleStop();
    if (matchesKey(data, Key.ctrl("t"))) return this.showBackendPicker();
    if (matchesKey(data, Key.ctrl("x"))) return this.closeThread();
    if (matchesKey(data, Key.ctrl("l"))) return this.nextLink();
    const typing = this.typing();
    if (!typing && data === "?") return this.show({ kind: "help" });

    if (matchesKey(data, Key.escape)) {
      if (typing) this.input.setValue("");
      else this.back();
      return this.tui.requestRender();
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
      if (this.focus === "thread") this.back();
      else if (this.agent) this.focus = this.focus === "agents" ? "threads" : "agents";
      return this.tui.requestRender();
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      const big = matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown);
      const d = (matchesKey(data, Key.up) || matchesKey(data, Key.pageUp) ? -1 : 1) * (big ? PAGE : 1);
      if (this.focus === "thread") this.scrollBy(d);
      else if (this.focus === "agents") this.moveAgent(d);
      else this.moveThread(d);
      return this.tui.requestRender();
    }
    if (!typing && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
      if (matchesKey(data, Key.left)) this.back();
      else if (this.focus === "agents" && this.agent) this.focus = "threads";
      else if (this.focus === "threads") await this.openSelected();
      return this.tui.requestRender();
    }
    if (!typing && /^[1-9]$/.test(data) && this.focus === "thread" && this.open?.meta.status === "waiting_on_you") {
      const q = this.question();
      const n = Number(data);
      if (q?.options?.length && n <= q.options.length) return this.answer(n, q.options[n - 1]);
    }
    if (matchesKey(data, Key.enter)) {
      if (typing) return this.submit();
      if (this.focus === "thread" && this.linkIdx >= 0) {
        const l = this.allLinks()[this.linkIdx];
        if (l) this.openLink(l.target);
        return;
      }
      if (this.focus === "agents") {
        if (this.agent) this.focus = "threads";
        else this.showNew();
        return this.tui.requestRender();
      }
      if (this.focus === "threads") return this.openSelected();
      return;
    }
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  private back(): void {
    if (this.focus === "thread") {
      const i = this.visibleThreads().findIndex((t) => t.id === this.open?.meta.id);
      if (i >= 0) this.threadIdx = i;
      this.open = null;
      this.linkIdx = -1;
      this.focus = "threads";
    } else this.focus = "agents";
  }

  private async openSelected(): Promise<void> {
    const t = this.visibleThreads()[this.threadIdx];
    if (t) await this.openThread(t);
  }

  private scrollBy(d: number): void {
    const cur = this.scroll === Number.MAX_SAFE_INTEGER ? this.lastShown : this.scroll;
    this.scroll = Math.max(0, cur + d);
    if (this.scroll >= this.lastMaxScroll) this.scroll = Number.MAX_SAFE_INTEGER;
    this.tui.requestRender();
  }

  private moveAgent(d: number): void {
    this.selectAgent(Math.min(Math.max(0, this.agentIdx + d), Math.max(0, this.agents.length - 1)));
  }

  private selectAgent(n: number): void {
    if (n !== this.agentIdx) {
      this.agentIdx = n;
      this.threads = [];
      this.threadIdx = 0;
      this.open = null;
      if (this.focus === "thread") this.focus = "threads";
      void this.refresh();
    }
    this.tui.requestRender();
  }

  private moveThread(d: number): void {
    this.threadIdx = Math.min(Math.max(0, this.threadIdx + d), Math.max(0, this.threads.length - 1));
    this.tui.requestRender();
  }

  /** The question being asked now: its options are the latest thing the agent wrote. */
  private question(): ThreadEntry | undefined {
    if (!this.open || this.open.meta.status !== "waiting_on_you") return undefined;
    const q = [...this.open.entries].reverse().find((e) => e.from === "agent");
    return q?.options?.length ? q : undefined;
  }

  private async answer(n: number, option: string): Promise<void> {
    if (!this.agent || !this.open) return;
    await this.c.call("answer", { name: this.agent.name, threadId: this.open.meta.id, choice: n });
    this.say(`Answered: ${option}`, "ok");
    await this.refresh();
  }

  private async submit(): Promise<void> {
    const text = this.input.getValue().trim();
    if (!text) return;
    if (!this.agent) return this.say("Create an agent first: press Ctrl+N.", "info");
    const a = this.agent;
    this.input.setValue("");
    this.tui.requestRender();
    if (this.focus === "thread" && this.open) {
      if (this.open.meta.status === "waiting_on_you") await this.c.call("answer", { name: a.name, threadId: this.open.meta.id, text });
      else await this.c.call("send", { name: a.name, threadId: this.open.meta.id, text });
      this.scroll = Number.MAX_SAFE_INTEGER;
      return this.refresh();
    }
    // A new agent's first message answers its greeting, so its job is set in one conversation.
    const greeting = a.status === "new" ? this.threads.find((t) => t.kind === "conversation") : undefined;
    const r = await this.c.call("send", greeting ? { name: a.name, threadId: greeting.id, text } : { name: a.name, text });
    await this.refresh();
    const t = this.threads.find((x) => x.id === (greeting?.id ?? r?.threadId));
    if (t) await this.openThread(t);
  }

  openLink(target: string): void {
    const note = this.opener(target);
    if (note) this.say(note, "info");
  }

  private allLinks() {
    return (this.open?.entries ?? []).flatMap((e) => e.links ?? []);
  }

  private nextLink(): void {
    if (this.focus !== "thread" || !this.open) return this.say("Open a thread first; then Ctrl+L steps through its links.", "info");
    const n = this.allLinks().length;
    if (!n) return this.say("This thread has no links.", "info");
    this.linkIdx = (this.linkIdx + 1) % n;
    this.tui.requestRender();
  }

  // ---------- actions ----------

  private needAgent(): AgentSummary | undefined {
    if (!this.agent) this.say("Create an agent first: press Ctrl+N.", "info");
    return this.agent;
  }

  private async wake(): Promise<void> {
    const a = this.needAgent();
    if (!a) return;
    await this.c.call("wake", { name: a.name });
    this.say(`Waking ${a.name} now.`, "ok");
    await this.refresh();
  }

  private async toggleStop(): Promise<void> {
    const a = this.needAgent();
    if (!a) return;
    if (a.status === "stopped") {
      await this.c.call("start", { name: a.name });
      this.say(`Started ${a.name}.`, "ok");
    } else {
      await this.c.call("stop", { name: a.name });
      this.say(`Stopped ${a.name}. Its folder and messages are kept; Ctrl+S starts it again.`, "ok");
    }
    await this.refresh();
  }

  private selectedThread(): ThreadMeta | undefined {
    return this.focus === "thread" ? this.open?.meta : this.focus === "threads" ? this.visibleThreads()[this.threadIdx] : undefined;
  }

  private async closeThread(): Promise<void> {
    const a = this.needAgent();
    if (!a) return;
    const t = this.selectedThread();
    if (!t) return this.say("Select a thread first, then Ctrl+X closes it.", "info");
    if (t.status === "closed") return this.say("That thread is already closed.", "info");
    await this.c.call("close", { name: a.name, id: t.id });
    if (this.focus === "thread") this.back();
    this.say(`Closed “${t.title.slice(0, 50)}”.`, "ok");
    await this.refresh();
  }

  private confirmArchive(): void {
    const a = this.needAgent();
    if (!a) return;
    this.show({
      kind: "confirm",
      title: `Archive ${a.name}?`,
      body: [`${a.name} stops for good and its folder moves to`, gray(join(paths.archiveDir(), a.name)), "", "Nothing is deleted; you can move the folder back later."],
      yes: "archive",
      run: async () => {
        await this.c.call("archive", { name: a.name });
        this.say(`Archived ${a.name}.`, "ok");
        this.focus = "agents";
        await this.refresh();
      },
    });
  }

  private show(o: Overlay): void {
    this.overlay = o;
    this.overlayInput.setValue("");
    this.tui.requestRender();
  }

  private showNew(): void {
    this.show({ kind: "new" });
  }

  private showSearch(): void {
    this.show({ kind: "search", hits: [], idx: 0 });
  }

  private showActions(): void {
    const a = this.agent;
    const items: ListItem[] = [];
    if (a) {
      const t = this.selectedThread();
      items.push({ label: a.name, heading: true });
      items.push({ label: "Wake now", key: "^R", run: () => this.wake() });
      items.push({ label: a.status === "stopped" ? "Start" : "Stop", key: "^S", run: () => this.toggleStop() });
      items.push({ label: "Backend and model…", key: "^T", note: `${a.backend}${a.model ? ` · ${a.model}` : ""}`, run: () => this.showBackendPicker() });
      items.push({ label: "Look behind", key: "^O", note: "folder, schedule, transcripts", run: () => this.showBehind() });
      if (t && t.status !== "closed") items.push({ label: "Close thread", key: "^X", note: t.title, run: () => this.closeThread() });
      items.push({ label: "Archive…", run: () => this.confirmArchive() });
    }
    items.push({ label: "Overtime", heading: true });
    items.push({ label: "New agent", key: "^N", run: () => this.showNew() });
    items.push({ label: "Search threads", key: "^F", run: () => this.showSearch() });
    items.push({ label: "Keys", key: "?", run: () => this.show({ kind: "help" }) });
    items.push({ label: "Quit", key: "^C", note: "agents keep running", run: () => this.quit() });
    this.show({ kind: "list", title: "Actions", items, idx: items.findIndex((i) => !i.heading) });
  }

  private async showBehind(): Promise<void> {
    const a = this.needAgent();
    if (!a) return;
    const d = await this.get("agent", { name: a.name });
    const items: ListItem[] = [
      { label: "Files", heading: true },
      { label: "Folder", note: tilde(a.dir), target: a.dir },
      { label: "AGENT.md", note: "who it is, its job and rules", target: join(a.dir, "AGENT.md") },
      { label: "INDEX.md", note: "its map of its folder", target: join(a.dir, "INDEX.md") },
      { label: "Transcripts", note: "everything it was sent and did", target: join(paths.meta(a.name), "runs") },
      { label: "Runs on", heading: true },
      { label: `${a.backend} · ${a.model ?? "default model"}`, note: `${money(a)} · Enter to change`, run: () => this.showBackendPicker() },
      { label: "Schedule", heading: true },
    ];
    const s = d?.schedule ?? { loops: [] };
    items.push({ label: s.wakeAt ? `Wakes ${when(s.wakeAt)}` : "No wake-up set", note: s.wakeReason ?? undefined });
    for (const l of s.loops ?? []) items.push({ label: `Every ${everyText(l.everyMs)}`, note: l.task });
    for (const m of d?.monitors ?? []) items.push({ label: `Watch · ${m.status}`, note: `${m.why} — ${m.run}` });
    const helpers = (d?.helpers ?? []).slice(-8).reverse();
    if (helpers.length) items.push({ label: "Helpers", heading: true });
    for (const h of helpers) items.push({ label: `${h.status === "running" ? green("● running") : gray(h.status)}  ${h.task.split("\n")[0]}`, target: h.workdir });
    const reports = (d?.reports ?? []).slice(-6).reverse();
    if (reports.length) items.push({ label: "Recent", heading: true });
    for (const r of reports) items.push({ label: r.text.split("\n")[0], note: `${ago(r.t)} ago` });
    this.show({ kind: "list", title: `Behind ${a.name}`, items, idx: items.findIndex((i) => !i.heading), hint: "Enter opens files" });
  }

  private async showBackendPicker(): Promise<void> {
    const a = this.needAgent();
    if (!a) return;
    let backends: string[] = [];
    try {
      backends = cleanDeep(await this.c.call<string[]>("backends"));
    } catch {}
    if (!backends?.length) backends = ["claude", "codex", "gemini"];
    if (!backends.includes(a.backend)) backends.unshift(a.backend);
    const items: ListItem[] = backends.map((b) => ({ label: b, current: b === a.backend, note: b === a.backend ? "current" : undefined, run: () => this.showModelPicker(a, b) }));
    this.show({ kind: "list", title: `${a.name} runs on`, items, idx: Math.max(0, backends.indexOf(a.backend)), hint: "then pick a model" });
  }

  private async showModelPicker(a: AgentSummary, backend: string): Promise<void> {
    const title = `${a.name} · ${backend} model`;
    this.show({ kind: "list", title, items: [], idx: 0, loading: `Asking ${backend} which models it offers…` });
    let models: { id: string; name: string }[] = [];
    try {
      models = cleanDeep(await this.c.call("models", { backend }, 90_000)) ?? [];
    } catch (e) {
      if (this.overlay?.kind === "list" && this.overlay.title === title) this.say(`Couldn't get ${backend}'s models: ${friendly(e)}`, "err");
    }
    if (this.overlay?.kind !== "list" || this.overlay.title !== title) return; // closed meanwhile
    const same = backend === a.backend;
    const apply = (model: string | null) => async () => {
      await this.c.call("set", { name: a.name, backend, model });
      this.say(`${a.name} will use ${backend} · ${model ?? "its default model"} from its next session.`, "ok");
      await this.refresh();
    };
    // The backend's own "default" entry stands for no choice; otherwise offer one.
    const hasDefault = models.some((m) => m.id === "default");
    const items: ListItem[] = hasDefault ? [] : [{ label: "Default", note: same && !a.model ? "current" : `whatever ${backend} picks`, current: same && !a.model, run: apply(null) }];
    for (const m of models) {
      const isDefault = m.id === "default";
      const cur = same && (isDefault ? !a.model || a.model === "default" : a.model === m.id);
      const label = m.name || m.id;
      const note = cur ? "current" : label.toLowerCase() !== m.id.toLowerCase() && !isDefault ? m.id : undefined;
      items.push({ label, note, current: cur, run: apply(isDefault ? null : m.id) });
    }
    if (!models.length) items.push({ label: `${backend} didn't list its models, so it will use its own default.`, info: true });
    const cur = items.findIndex((i) => i.current);
    this.overlay = { kind: "list", title, items, idx: cur >= 0 ? cur : 0, hint: "applies from its next session" };
    this.tui.requestRender();
  }

  private async overlayKey(data: string): Promise<void> {
    const o = this.overlay!;
    if (matchesKey(data, Key.escape)) {
      this.overlay = null;
      return this.tui.requestRender();
    }
    if (o.kind === "help") {
      this.overlay = null;
      return this.tui.requestRender();
    }
    if (o.kind === "confirm") {
      if (data === "y" || data === "Y") {
        this.overlay = null;
        await o.run();
      } else if (data === "n" || data === "N" || matchesKey(data, Key.enter)) this.overlay = null;
      return this.tui.requestRender();
    }
    if (o.kind === "list") {
      const selectable = (i: number) => !!o.items[i] && !o.items[i].heading && !o.items[i].info;
      const step = (d: number) => {
        for (let i = o.idx + d; i >= 0 && i < o.items.length; i += d) {
          if (selectable(i)) {
            o.idx = i;
            return;
          }
        }
      };
      if (matchesKey(data, Key.up)) step(-1);
      else if (matchesKey(data, Key.down)) step(1);
      else if (matchesKey(data, Key.enter)) {
        const it = o.items[o.idx];
        if (it?.run) {
          this.overlay = null;
          await it.run();
        } else if (it?.target) this.openLink(it.target);
      } else {
        // An action's own shortcut works from inside the menu too.
        const hit = o.items.find((i) => i.key?.startsWith("^") && matchesKey(data, Key.ctrl(i.key.slice(1).toLowerCase() as any) as any));
        if (hit?.run) {
          this.overlay = null;
          await hit.run();
        }
      }
      return this.tui.requestRender();
    }
    if (o.kind === "search") {
      if (matchesKey(data, Key.up)) o.idx = Math.max(0, o.idx - 1);
      else if (matchesKey(data, Key.down)) o.idx = Math.min(Math.max(0, o.hits.length - 1), o.idx + 1);
      else if (matchesKey(data, Key.enter)) {
        const hit = o.hits[o.idx];
        if (hit) {
          this.overlay = null;
          this.agentIdx = Math.max(0, this.agents.findIndex((a) => a.name === hit.agent));
          await this.refresh();
          await this.openThread(hit.thread);
        }
      } else {
        this.overlayInput.handleInput(data);
        o.hits = await this.runSearch(this.overlayInput.getValue());
        o.idx = 0;
      }
      return this.tui.requestRender();
    }
    if (o.kind === "new") {
      if (matchesKey(data, Key.enter)) {
        const name = this.overlayInput.getValue().trim();
        const err = name ? validateName(name) : "Type a name first.";
        if (err) {
          o.error = err;
          return this.tui.requestRender();
        }
        if (this.agents.some((a) => a.name === name)) {
          o.error = `There's already an agent called ${name}.`;
          return this.tui.requestRender();
        }
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
      const v = this.overlayInput.getValue().trim();
      o.error = v ? (validateName(v) ?? undefined) : undefined;
      return this.tui.requestRender();
    }
  }

  private async runSearch(q: string): Promise<{ agent: string; thread: ThreadMeta }[]> {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const hits: { agent: string; thread: ThreadMeta }[] = [];
    for (const a of this.agents) {
      const ths: ThreadMeta[] = await this.get("threads", { name: a.name });
      const nameHit = a.name.toLowerCase().includes(needle);
      for (const t of ths) if (nameHit || t.title.toLowerCase().includes(needle)) hits.push({ agent: a.name, thread: t });
    }
    return hits.sort((x, y) => y.thread.updatedAt.localeCompare(x.thread.updatedAt)).slice(0, 40);
  }

  quit(): void {
    this.tui.stop();
    this.c.close();
    this.onQuit();
  }

  // ---------- rendering ----------

  render(width: number): string[] {
    this.hits = [];
    const rows = Math.max(6, this.term.rows);
    const composerH = rows >= 14 ? 3 : 1;
    const bodyH = Math.max(1, rows - HEADER_ROWS - composerH - 1);
    const narrow = width < NARROW;
    const leftW = narrow ? width : Math.min(36, Math.max(30, Math.floor(width * 0.3)));
    const rightW = narrow ? width : width - leftW - 1;
    this.leftW = narrow ? 0 : leftW;

    const out: string[] = [this.renderHeader(width), this.connected ? rule(width) : red("━".repeat(width))];
    // Narrow terminals show one pane: the agent list, or whatever is open on the right.
    const showLeft = !narrow || (!this.overlay && this.focus === "agents");
    const showRight = !narrow || !showLeft;
    const left = showLeft ? this.renderAgents(leftW, bodyH) : [];
    const right = showRight ? this.renderRight(rightW, bodyH, narrow ? 0 : leftW + 1) : [];
    for (let i = 0; i < bodyH; i++) {
      if (!narrow) out.push(fit(left[i] ?? "", leftW) + gray("│") + fit(right[i] ?? "", rightW));
      else out.push(fit((showLeft ? left[i] : right[i]) ?? "", width));
    }
    out.push(...this.renderComposer(width, composerH));
    out.push(fit(this.renderFooter(width), width));
    return out;
  }

  private renderHeader(w: number): string {
    const title = ` ${accent("◆")} ${bold("overtime")}`;
    if (!this.connected) return spread(title, red("can't reach the background process · reconnecting…") + " ", w);
    const working = this.agents.filter((a) => a.status === "working").length;
    const needs = this.agents.reduce((n, a) => n + a.waiting, 0);
    const parts = [gray(`${this.agents.length} agent${this.agents.length === 1 ? "" : "s"}`), working ? green(`${working} working`) : "", needs ? yellow(`${needs} need${needs === 1 ? "s" : ""} you`) : ""].filter(Boolean);
    return spread(title, parts.join(gray("  ·  ")) + " ", w);
  }

  private agentDetail(a: AgentSummary): string {
    const p = statusParts(a);
    const live = this.mainLive(a.name);
    if (a.status === "working") return live?.step || a.activity || p.detail;
    return p.detail;
  }

  private renderAgents(w: number, h: number): string[] {
    const focused = this.focus === "agents" && !this.overlay;
    const lines: string[] = [" " + (focused ? accent(bold("AGENTS")) : gray("AGENTS")), ""];
    const footer = 2;
    const per = 3;
    const visible = Math.max(1, Math.floor((h - lines.length - footer) / per));
    const start = Math.max(0, Math.min(this.agentIdx - Math.floor(visible / 2), this.agents.length - visible));
    this.agents.slice(start, start + visible).forEach((a, i) => {
      const idx = start + i;
      const sel = idx === this.agentIdx;
      const bar = sel ? (focused ? accent("▌") : gray("▌")) : " ";
      const n = a.waiting + a.unread;
      const badge = n ? (a.waiting ? yellow(bold(String(n))) : accent(String(n))) : "";
      const p = statusParts(a);
      const detail = this.agentDetail(a);
      let l1 = bar + " " + spread(sel ? bold(a.name) : a.name, badge + " ", w - 2);
      let l2 = bar + "   " + fit(`${p.color(`${p.dot} ${p.word}`)}${detail ? gray(` · ${detail}`) : ""}`, w - 4);
      if (sel && focused) {
        l1 = selectedBg(fit(l1, w));
        l2 = selectedBg(fit(l2, w));
      }
      const row = HEADER_ROWS + lines.length;
      const pick = () => {
        this.overlay = null;
        this.focus = "agents";
        this.selectAgent(idx);
      };
      this.hits.push({ row, x0: 0, x1: w, act: pick }, { row: row + 1, x0: 0, x1: w, act: pick });
      lines.push(l1, l2, "");
    });
    if (!this.agents.length) lines.push(gray("   No agents yet."), "");
    if (this.agents.length > visible) lines.push(gray(`   ${this.agentIdx + 1} of ${this.agents.length}`));
    while (lines.length < h - 1) lines.push("");
    lines.length = Math.max(0, h - 1);
    this.hits.push({ row: HEADER_ROWS + lines.length, x0: 0, x1: w, act: () => this.showNew() });
    lines.push(" " + accent("+ New agent") + "  " + gray("^N"));
    return lines;
  }

  private renderRight(w: number, h: number, x: number): string[] {
    if (this.overlay) return this.renderOverlay(w, h);
    if (!this.agent) return this.renderWelcome(w);
    if (this.focus === "thread" && this.open) return this.renderThread(w, h, x);
    return this.renderThreads(w, h, x);
  }

  private renderWelcome(w: number): string[] {
    const pad = (s: string) => "   " + s;
    const wrap = (s: string) => wrapTextWithAnsi(s, Math.max(20, Math.min(70, w - 6))).map(pad);
    return [
      "",
      pad(bold("Welcome to Overtime")),
      "",
      ...wrap("Overtime runs agents that keep working on their own. Each one has a name, a folder and a job. You brief it once; it plans, works, keeps notes, and checks in here only when it needs you."),
      "",
      pad(`${accent(bold("1"))}  Press ${bold("Ctrl+N")} and give your first agent a name.`),
      pad(`${accent(bold("2"))}  Tell it what it's for, in plain words.`),
      pad(`${accent(bold("3"))}  It writes down its job and gets started.`),
      "",
      ...wrap(gray("Agents keep running when you close this window. Press ? for keys.")),
    ];
  }

  private renderAgentHeader(a: AgentSummary, w: number): string[] {
    const p = statusParts(a);
    const detail = this.agentDetail(a);
    const state = `${p.color(`${p.dot} ${p.word}`)}${detail ? gray(` · ${detail}`) : ""}`;
    const runsOn = `${a.backend} · ${a.model ?? "default model"}`;
    const doing = a.activity && a.status !== "new" && a.status !== "working" && !/^(paused|stopped|resting|resuming)/.test(a.activity) ? italic(gray(a.activity)) : "";
    const lines = [spread(` ${bold(a.name)}  ${state}`, gray(money(a)) + " ", w), spread(` ${doing}`, gray(runsOn) + " ", w)];
    if (a.lastError && a.status !== "working") lines.push(` ${red("Last turn failed:")} ${gray(a.lastError)}`);
    lines.push(rule(w));
    return lines;
  }

  private renderThreads(w: number, h: number, x: number): string[] {
    const a = this.agent!;
    const focused = this.focus === "threads" && !this.overlay;
    const lines = [...this.renderAgentHeader(a, w), ""];
    if (a.status === "new") {
      const bw = Math.min(w - 2, 76);
      lines.push(
        ...box(
          `Give ${a.name} its job`,
          ["Tell it in plain words what it's for, and what it should always", "check with you first. It writes that down as its AGENT.md and starts.", "", gray("e.g. “Keep my repo's CI green and dependencies current."), gray("      Ask before merging anything that ships.”")],
          bw,
        ).map((l) => " " + l),
        "",
      );
    }
    const list = this.visibleThreads();
    if (!list.length) {
      lines.push(gray("   No threads yet. Write below to start one."));
      return lines;
    }
    const flat: (string | { t: ThreadMeta; i: number })[] = [];
    let group = "";
    list.forEach((t, i) => {
      const g = t.status === "waiting_on_you" ? "NEEDS YOU" : t.status === "closed" ? "CLOSED" : "THREADS";
      if (g !== group) {
        if (flat.length) flat.push("");
        flat.push(g);
        group = g;
      }
      flat.push({ t, i });
    });
    // Keep the selected thread in view.
    const avail = Math.max(1, h - lines.length);
    const selRow = flat.findIndex((r) => typeof r !== "string" && r.i === this.threadIdx);
    const start = Math.max(0, Math.min(selRow - Math.floor(avail / 2), flat.length - avail));
    for (const r of flat.slice(start, start + avail)) {
      if (typeof r === "string") {
        lines.push(r ? "   " + (r === "NEEDS YOU" ? yellow(bold(r)) : gray(r)) : "");
        continue;
      }
      const { t, i } = r;
      const sel = i === this.threadIdx;
      const icon = t.status === "waiting_on_you" ? yellow("?") : t.kind === "alert" ? red("!") : t.kind === "report" ? accent("•") : t.status === "closed" ? gray("✓") : gray("›");
      const right = [
        this.chatLive(a.name, t.id) ? green("typing…") : t.status === "waiting_on_you" ? yellow("needs you") : t.unread ? accent(`${t.unread} new`) : t.kind === "question" && t.status === "answered" ? gray("answered") : "",
        gray(ago(t.updatedAt).padStart(4)),
      ]
        .filter(Boolean)
        .join("  ");
      const title = t.status === "closed" ? gray(t.title) : t.unread || t.status === "waiting_on_you" ? bold(t.title) : t.title;
      const bar = sel ? (focused ? accent("▌") : gray("▌")) : " ";
      let line = bar + "  " + spread(`${icon} ${title}`, right + " ", w - 3);
      if (sel && focused) line = selectedBg(fit(line, w));
      this.hits.push({
        row: HEADER_ROWS + lines.length,
        x0: x,
        x1: x + w,
        act: async () => {
          this.overlay = null;
          this.threadIdx = i;
          await this.openThread(t);
        },
      });
      lines.push(line);
    }
    return lines;
  }

  private renderThread(w: number, h: number, x: number): string[] {
    const th = this.open!;
    const name = this.agent!.name;
    const state = th.meta.status === "waiting_on_you" ? yellow("needs you") : th.meta.status === "closed" ? gray("closed") : th.meta.kind === "question" ? gray("answered") : th.meta.kind === "conversation" ? "" : gray(th.meta.kind);
    this.hits.push({ row: HEADER_ROWS, x0: x, x1: x + 4 + visibleWidth(name), act: () => (this.back(), this.tui.requestRender()) });
    const header = [spread(` ${gray("←")} ${accent(name)} ${gray("/")} ${bold(th.meta.title)}`, state + " ", w), rule(w)];
    const body: string[] = [];
    const bodyHits: { line: number; act: () => void | Promise<void> }[] = [];
    const inner = Math.max(10, w - 4);
    const wrap = (s: string, indent = "   ") => wrapTextWithAnsi(s, Math.max(8, inner - visibleWidth(indent) + 2)).map((l) => indent + l);
    const q = this.question();
    let linkN = 0;
    let lastStart = 0;
    th.entries.forEach((e, ei) => {
      lastStart = body.length;
      const who = e.from === "you" ? bold("You") : e.from === "agent" ? accent(bold(name)) : yellow(bold("Overtime"));
      body.push(` ${who}  ${gray(stamp(e.t))}`);
      for (const para of e.text.split("\n")) body.push(...(para.trim() ? wrap(para) : [""]));
      if (e.why) body.push("", ...wrap(`${gray("Why it matters ·")} ${e.why}`));
      if (e.recommendation) body.push("", ...wrap(`${bold("Recommended ·")} ${e.recommendation}`, `   ${accent("▍")} `));
      if (e.options?.length) {
        body.push("");
        const current = q === e;
        const chosen = th.entries.slice(ei + 1).find((x) => x.from === "you" && x.choice)?.choice;
        e.options.forEach((o, i) => {
          const n = i + 1;
          if (current) {
            bodyHits.push({ line: body.length, act: () => this.answer(n, o) });
            body.push(`    ${inverse(accent(` ${n} `))}  ${o}`);
          } else body.push(`    ${chosen === n ? green("✓") : gray("·")}  ${chosen === n ? o : gray(o)}`);
        });
        if (current) body.push("", gray(`    Press ${e.options.length === 1 ? "1" : `1–${e.options.length}`} to answer, or write your own answer below.`));
      }
      if (e.links?.length) {
        body.push("");
        for (const l of e.links) {
          const url = l.kind === "url" ? l.target : pathToFileURL(l.target).href;
          const label = l.kind === "url" ? l.label : tilde(l.label);
          const target = l.target;
          bodyHits.push({ line: body.length, act: () => this.openLink(target) });
          body.push(`    ${linkN === this.linkIdx ? inverse(` ↗ ${link(url, label)} `) : accent(`↗ ${link(url, underline(label))}`)}${l.kind === "url" ? "" : gray(`  ${l.kind}`)}`);
          linkN++;
        }
      }
      body.push("");
    });
    const live = this.chatLive(name, th.meta.id);
    if (live) {
      body.push(` ${accent(bold(name))}  ${gray(spinner())} ${gray(live.step ?? (live.text ? "writing…" : "thinking…"))}`);
      const text = live.text.trim();
      if (text) for (const para of text.split("\n").slice(-30)) body.push(...(para.trim() ? wrap(dim(para)) : [""]));
      body.push("");
    }
    const viewH = Math.max(1, h - header.length);
    const maxScroll = Math.max(0, body.length - viewH);
    this.lastMaxScroll = maxScroll;
    // Following the end, the newest message is shown from its start when it is longer than the view.
    const s = this.scroll === Number.MAX_SAFE_INTEGER && !live ? Math.min(maxScroll, lastStart) : Math.min(this.scroll, maxScroll);
    this.lastShown = s;
    const shown = body.slice(s, s + viewH);
    if (s > 0 && shown.length > 1) shown[0] = gray(`    ↑ ${s} earlier line${s === 1 ? "" : "s"}`);
    if (s < maxScroll && shown.length === viewH && viewH > 1) shown[viewH - 1] = gray(`    ↓ more below`);
    for (const bh of bodyHits) {
      const row = bh.line - s;
      if (row >= 0 && row < viewH) this.hits.push({ row: HEADER_ROWS + header.length + row, x0: x, x1: x + w, act: bh.act });
    }
    return [...header, ...shown];
  }

  private renderOverlay(w: number, h: number): string[] {
    const o = this.overlay!;
    const bw = Math.max(20, Math.min(w - 2, 76));
    const pad = (ls: string[]) => ["", ...ls.map((l) => " " + l)];
    if (o.kind === "new") {
      this.overlayInput.focused = true;
      const field = this.overlayInput.render(Math.max(4, bw - 12))[0] ?? "";
      return pad(
        box(
          "New agent",
          [
            "",
            `${bold("Name")}  ${field}`,
            ...(o.error ? wrapTextWithAnsi(o.error, bw - 4).map(red) : [gray("lowercase letters, digits and dashes, e.g. repo-keeper")]),
            "",
            "It starts with no job. Your first message tells it what it's for;",
            "it writes its own AGENT.md from that and gets to work.",
            "",
          ],
          bw,
          { footer: `${key("⏎", "create")}  ${key("esc", "cancel")}` },
        ),
      );
    }
    if (o.kind === "help") {
      const row = (k: string, d: string) => `${bold(fit(k, 12))}${d}`;
      return pad(
        box(
          "Keys",
          [
            gray("MOVING"),
            row("↑ ↓", "move through agents and threads, or scroll a thread"),
            row("→  ⏎", "open            ←  esc   back"),
            row("tab", "switch between agents and threads"),
            "",
            gray("TALKING"),
            row("just type", "write a message; ⏎ sends it"),
            row("1–9", "answer the open question with that option"),
            row("^L  ⏎", "step through a thread's links; open one"),
            "",
            gray("AGENTS"),
            row("^P", "all actions for the selected agent"),
            row("^N", "new agent             ^F  search threads"),
            row("^R", "wake it now           ^S  stop or start it"),
            row("^T", "backend and model     ^X  close a thread"),
            row("^O", "look behind: folder, schedule, watches, transcripts"),
            "",
            row("^C", "quit (your agents keep running)"),
          ],
          bw,
          { footer: gray("any key closes") },
        ),
      );
    }
    if (o.kind === "confirm") return pad(box(o.title, ["", ...o.body, ""], bw, { footer: `${key("y", o.yes)}  ${key("n", "cancel")}` }));
    if (o.kind === "search") {
      this.overlayInput.focused = true;
      const field = this.overlayInput.render(Math.max(4, bw - 14))[0] ?? "";
      const body = [`${bold("Find")}  ${field}`, ""];
      if (!o.hits.length) body.push(gray(this.overlayInput.getValue() ? "No threads match." : "Type part of an agent's name or a thread's title."));
      o.hits.slice(0, Math.max(1, h - 7)).forEach((s, i) => {
        const line = spread(`${accent(s.agent)}  ${s.thread.title}`, gray(ago(s.thread.updatedAt)), bw - 7);
        body.push(i === o.idx ? selectedBg(fit(accent("❯") + " " + line, bw - 4)) : "  " + line);
      });
      return pad(box("Search", body, bw, { footer: `${key("↑↓", "move")}  ${key("⏎", "open")}  ${key("esc", "close")}` }));
    }
    const body: string[] = [];
    if (o.loading) body.push("", `${gray(spinner())} ${gray(o.loading)}`, "");
    const maxRows = Math.max(3, h - 5);
    const start = Math.max(0, Math.min(o.idx - Math.floor(maxRows / 2), o.items.length - maxRows));
    o.items.slice(start, start + maxRows).forEach((it, k) => {
      const i = start + k;
      if (it.heading) {
        if (body.length) body.push("");
        body.push(gray(it.label.toUpperCase()));
        return;
      }
      if (it.info) {
        body.push("", ...wrapTextWithAnsi(gray(it.label), bw - 6).map((l) => "  " + l));
        return;
      }
      const sel = i === o.idx;
      const left = `${it.current ? accent("●") : " "} ${sel ? accent(bold(it.label)) : it.label}${it.note ? gray(`  ${it.note}`) : ""}`;
      const line = spread(left, it.key ? gray(it.key) : "", bw - 7);
      body.push(sel ? selectedBg(fit(accent("❯") + " " + line, bw - 4)) : "  " + line);
    });
    const footer = `${key("↑↓", "move")}  ${key("⏎", "choose")}  ${key("esc", "close")}${o.hint ? gray(` · ${o.hint}`) : ""}`;
    return pad(box(o.title, body, bw, { footer }));
  }

  private composerPlaceholder(): string {
    const a = this.agent;
    if (!a) return "Press Ctrl+N to create your first agent";
    if (this.focus === "thread" && this.open) {
      const q = this.question();
      if (q) return `Press 1–${q.options!.length}, or write an answer…`;
      return `Reply to ${a.name}…`;
    }
    if (a.status === "new") return `Tell ${a.name} what it's for…`;
    if (a.status === "stopped") return `Message ${a.name} (stopped; it reads this when started)…`;
    return `Message ${a.name} · starts a new thread…`;
  }

  private renderComposer(w: number, h: number): string[] {
    const active = !this.overlay;
    this.input.focused = active;
    if (active) this.overlayInput.focused = false;
    const ph = this.composerPlaceholder();
    (this.input as any).placeholder = ph;
    const inner = Math.max(4, w - 6);
    const field = active ? (this.input.render(inner)[0] ?? "") : gray(fit(ph, inner));
    const prompt = active ? accent("›") : gray("›");
    if (h < 3) return [fit(` ${prompt} ${field}`, w)];
    const c = active && (this.typing() || this.focus === "thread") ? accent : gray;
    return [c("╭" + "─".repeat(Math.max(0, w - 2)) + "╮"), c("│") + " " + prompt + " " + fit(field, w - 6) + " " + c("│"), c("╰" + "─".repeat(Math.max(0, w - 2)) + "╯")];
  }

  private renderFooter(w: number): string {
    if (this.flash) {
      const f = this.flash;
      const icon = f.tone === "ok" ? green("✓") : f.tone === "err" ? red("✗") : accent("›");
      return ` ${icon} ${f.tone === "err" ? red(f.text) : f.text}`;
    }
    let hints: string[];
    if (this.overlay) hints = [];
    else if (this.typing()) hints = [key("⏎", "send"), key("esc", "clear")];
    else if (!this.agent) hints = [key("^N", "new agent"), key("?", "keys"), key("^C", "quit")];
    else if (this.focus === "thread") {
      const q = this.question();
      hints = [q ? key(`1–${q.options!.length}`, "answer") : "", key("↑↓", "scroll"), this.allLinks().length ? key("^L", "links") : "", key("esc", "back"), key("^P", "actions"), key("?", "keys")].filter(Boolean);
    } else if (this.focus === "threads") hints = [key("↑↓", "select"), key("⏎", "open"), key("←", "agents"), key("^P", "actions"), key("?", "keys")];
    else hints = [key("↑↓", "select"), key("→", "threads"), key("^P", "actions"), key("^N", "new agent"), key("^F", "search"), key("?", "keys")];
    while (hints.length > 1 && visibleWidth(" " + hints.join("   ")) > w) hints.pop();
    return " " + hints.join("   ");
  }
}

function tilde(p: string): string {
  const h = process.env.HOME;
  return h && p.startsWith(h + "/") ? "~" + p.slice(h.length) : p;
}

function everyText(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

export interface AppOptions {
  terminal?: Terminal;
  client?: DaemonClient;
  onQuit?: () => void;
  /** How links and files are opened (tests replace this). Returns a note to show, if any. */
  opener?: (target: string) => string | void;
  /** How to reach the daemon again after it went away (default: start it if needed). */
  reconnect?: () => Promise<DaemonClient>;
  /** Mouse clicks and wheel. On by default in a real terminal. */
  mouse?: boolean;
}

export async function runApp(o: AppOptions = {}): Promise<{ app: App; tui: TuiAltScreen; stop: () => void }> {
  const connectFn = o.reconnect ?? ensureDaemon;
  const c = o.client ?? (await connectFn());
  const term = o.terminal ?? new ProcessTerminal();
  const opener = o.opener ?? openTarget;
  const tui = new TuiAltScreen(term, false, undefined, { openUrl: (url) => app.openLink(url), copyOnSelect: true, mouse: o.mouse ?? !o.terminal });
  const timers: NodeJS.Timeout[] = [];
  let quitting = false;
  const app = new App(c, tui, term, () => {
    quitting = true;
    for (const t of timers) clearInterval(t);
    (o.onQuit ?? (() => process.exit(0)))();
  }, opener);
  tui.addChild(app);
  tui.setFocus(app);
  tui.start();

  // If the daemon goes away (restarted, upgraded, crashed), keep the screen and reconnect when it's back.
  const attach = async (client: DaemonClient): Promise<void> => {
    app.c = client;
    await client.subscribe((e: any) => {
      if (e?.event === "live") app.onLive(e);
      else void app.refresh();
    });
    try {
      app.setLive(await client.call("live"));
    } catch {}
    await app.refresh();
    void client.closed.then(async () => {
      if (quitting) return;
      app.connected = false;
      app.live.clear();
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
  // Spinners move while anything is live; relative times and counts stay current.
  timers.push(setInterval(() => app.live.size && tui.requestRender(), 120));
  timers.push(setInterval(() => void app.refresh(), 15_000));
  return { app, tui, stop: () => app.quit() };
}
