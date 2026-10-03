import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  getKeybindings,
  Input,
  Key,
  ProcessTerminal,
  TuiAltScreen,
  getCapabilities,
  getImageDimensions,
  matchesKey,
  renderImage,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Terminal,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { ensureDaemon, type DaemonClient } from "../daemon/client.js";
import type { AgentSummary } from "../daemon/control.js";
import { validateName } from "../agent/agent.js";
import { paths } from "../paths.js";
import { pastedFiles, type PendingAttachment } from "./attach.js";
import {
  accent,
  applyTerminalColors,
  bold,
  cleanDeep,
  element,
  faint,
  fit,
  friendly,
  hasTints,
  inverse,
  box,
  italic,
  link,
  money,
  muted,
  openTarget,
  panel,
  red,
  selected,
  spread,
  stamp,
  statusParts,
  underline,
  when,
  yellow,
} from "./style.js";
import { headed, humanBytes, openQuestion, type AgentSettingsView, type LiveState, type Message } from "./types.js";

export { clean, cleanDeep, openPlan } from "./style.js";
export type { LiveState, Message } from "./types.js";

// ---------- layout ----------

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const spinner = () => SPINNER[Math.floor(Date.now() / 90) % SPINNER.length];
/** Below this width the agent list is hidden; ↑↓ still switch agents. */
const NARROW = 80;
const PAGE = 10;
/** Rows above the panes: the title bar and its rule. */
/** Rows above the panes: one empty row, so the first line isn't pressed against the top edge. */
const TOP = 1;
/** A quiet gap (minutes) after which the agent's name is shown again above its next message. */
const REGROUP_MIN = 10;

const sep = faint("  ·  ");
const keyHint = (k: string, label: string) => `${k} ${muted(label)}`;

/** A line of the message view: text, or a raw image line that must not be fitted or truncated. */
type Line = string | { image: string; rows: number };

/** A clickable area recorded while drawing, so mouse clicks map back to what was under them. */
interface Hit {
  row: number;
  x0: number;
  x1: number;
  act: () => void | Promise<void>;
}

interface PickItem {
  label: string;
  note?: string;
  current?: boolean;
  info?: boolean;
  run?: () => void | Promise<void>;
}

type Field = "backend" | "model" | "budget" | "tokens" | "workspace" | "protect";

interface SettingsRow {
  label: string;
  value?: string;
  note?: string;
  heading?: boolean;
  field?: Field;
  run?: () => void | Promise<void>;
  /** Keep the panel open after running (wake, stop/start). */
  stay?: boolean;
  danger?: boolean;
}

type SettingsOverlay = { kind: "settings"; data: AgentSettingsView | null; extra: any; idx: number; editing?: Field; error?: string };
type Overlay =
  | null
  | { kind: "help" }
  | SettingsOverlay
  | { kind: "pick"; title: string; items: PickItem[]; idx: number; loading?: string; back?: boolean }
  | { kind: "confirm"; title: string; body: string[]; yes: string; run: () => Promise<void>; danger?: boolean; focus: 0 | 1 };

/** The bits of Markdown agents write most, shown as styling instead of raw symbols: headings, **bold**, `code`. */
export function md(text: string): string {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return null;
      }
      if (inFence) return accent(line);
      const h = /^#{1,6}\s+(.*)$/.exec(line);
      if (h) return bold(h[1]);
      return line.replace(/\*\*([^*\n]+)\*\*/g, (_, x) => bold(x)).replace(/`([^`\n]+)`/g, (_, x) => accent(x));
    })
    .filter((l): l is string => l !== null)
    .join("\n");
}

const FIELD_LABEL: Record<Field, string> = { backend: "Backend", model: "Model", budget: "Daily budget", tokens: "Token budget", workspace: "Workspace", protect: "Protected paths" };

/** The whole screen: agents on the left like DMs, the selected agent's messages on the right, a composer below. */
export class App implements Component {
  agents: AgentSummary[] = [];
  /** Index into the agent list; agents.length is the "+ New agent" row. */
  sel = 0;
  messages: Message[] = [];
  hasMore = false;
  /** Lines from the top of the message view; MAX means "follow the newest". */
  scroll = Number.MAX_SAFE_INTEGER;
  /** Which link or file Ctrl+L has stepped to (-1: none). */
  linkIdx = -1;
  overlay: Overlay = null;
  flash: { text: string; tone: "ok" | "err" | "info" } | null = null;
  input = new Input({ prompt: "", placeholderStyle: muted });
  fieldInput = new Input({ prompt: "", placeholderStyle: muted });
  pending: PendingAttachment[] = [];
  connected = true;
  live = new Map<string, LiveState>();
  private hits: Hit[] = [];
  private inflight: Promise<void> | null = null;
  private again = false;
  private flashTimer: NodeJS.Timeout | null = null;
  private lastMax = 0;
  private lastTop = 0;
  private leftW = 0;
  private loadedFor = "";
  private started = false;
  /** The selected agent's name (null: the "+ New agent" row). */
  private selName: string | null = null;
  private images = new Map<string, { b64: string; w: number; h: number } | null>();

  constructor(public c: DaemonClient, private readonly tui: TuiAltScreen, private readonly term: Terminal, private readonly onQuit: () => void, private readonly opener: (t: string) => string | void = openTarget) {}

  get agent(): AgentSummary | undefined {
    return this.agents[this.sel];
  }

  get onNewRow(): boolean {
    return this.sel >= this.agents.length;
  }

  invalidate(): void {}

  // ---------- data ----------

  /** A read from the daemon, with everything agent-written made safe to print. */
  private async get<T = any>(method: string, params: Record<string, unknown> = {}, timeout?: number): Promise<T> {
    return cleanDeep(await this.c.call<T>(method, params, timeout));
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
      this.agents = (await this.get<AgentSummary[]>("agents")) ?? [];
      if (!this.started) {
        // First load: open on the agent that needs you, else the first one.
        this.started = true;
        const needs = this.agents.findIndex((a) => a.waiting > 0);
        this.sel = needs >= 0 ? needs : 0;
      } else if (this.selName) {
        // The selection follows the agent by name, so a list that changed underneath never moves it.
        const i = this.agents.findIndex((a) => a.name === this.selName);
        this.sel = i >= 0 ? i : Math.min(this.sel, this.agents.length);
      } else this.sel = this.agents.length; // stays on "+ New agent"
      this.selName = this.agent?.name ?? null;
      const a = this.onNewRow ? undefined : this.agent;
      if (a) {
        const r = await this.get<{ messages: Message[]; hasMore: boolean }>("messages", { name: a.name, markRead: true, limit: 300 });
        if (this.agent?.name !== a.name) return;
        const fresh = r?.messages ?? [];
        if (this.loadedFor !== a.name) this.scroll = Number.MAX_SAFE_INTEGER;
        this.messages = fresh;
        this.hasMore = !!r?.hasMore;
        this.loadedFor = a.name;
        if (this.overlay?.kind === "settings" && !this.overlay.editing) await this.loadSettings(this.overlay);
      } else {
        this.messages = [];
        this.loadedFor = "";
        if (this.overlay?.kind === "settings") this.overlay = null;
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

  /** Older messages, when scrolled to the top. */
  private async loadOlder(): Promise<void> {
    const a = this.agent;
    if (!a || this.onNewRow || !this.hasMore || !this.messages.length) return;
    const r = await this.get<{ messages: Message[]; hasMore: boolean }>("messages", { name: a.name, before: this.messages[0].id, limit: 300 });
    if (this.agent?.name !== a.name) return;
    this.messages = [...(r?.messages ?? []), ...this.messages];
    this.hasMore = !!r?.hasMore;
    this.tui.requestRender();
  }

  /** Streamed progress from a running session. */
  onLive(e: LiveState): void {
    const k = `${e.agent}/${e.kind}/${e.helperId ?? ""}`;
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

  private chatLive(agent: string): LiveState | undefined {
    return this.live.get(`${agent}/chat/`);
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
      const d = (ev.wheelDelta ?? 0) > 0 ? 1 : -1;
      if (this.leftW > 0 && ev.screenX < this.leftW && !this.overlay) this.select(this.sel + d);
      else if (this.overlay?.kind === "settings") this.moveSettings(d);
      else if (this.overlay?.kind === "pick") this.movePick(d);
      else this.scrollBy(d * 3);
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
    // A drag and drop of files pastes their paths: those become attachments, not text.
    if (data.startsWith("\x1b[200~") && !this.overlay && !this.onNewRow) {
      const files = pastedFiles(data.slice(6).replace(/\x1b\[201~[\s\S]*$/, ""));
      if (files) return this.attach(files);
    }
    if (this.overlay) return this.overlayKey(data);

    if (matchesKey(data, Key.ctrl("n"))) return this.select(this.agents.length);
    if (matchesKey(data, Key.ctrl("r"))) return this.wake();
    if (matchesKey(data, Key.ctrl("s"))) return this.toggleStop();
    if (matchesKey(data, Key.ctrl("t"))) return this.showBackendPicker(false);
    if (matchesKey(data, Key.ctrl("l"))) return this.nextLink();
    if (matchesKey(data, Key.ctrl("o"))) return this.agent && !this.onNewRow ? this.openLink(this.agent.dir) : undefined;
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.ctrl("p"))) return this.showSettings();
    const typing = this.typing();
    // → moves right, into the selected agent's settings (← or Esc comes back), as long as you aren't typing.
    if (!typing && !this.onNewRow && this.agent && matchesKey(data, Key.right)) return this.showSettings();
    if (!typing && data === "?") return this.show({ kind: "help" });

    if (matchesKey(data, Key.escape)) {
      if (typing) this.input.setValue("");
      else if (this.linkIdx >= 0) this.linkIdx = -1;
      else if (this.pending.length) this.pending = [];
      return this.tui.requestRender();
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) return this.select(this.sel + (matchesKey(data, Key.up) ? -1 : 1));
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) return this.scrollBy(matchesKey(data, Key.pageUp) ? -PAGE : PAGE);
    if (!typing && matchesKey(data, Key.backspace) && this.pending.length) {
      this.pending.pop();
      return this.tui.requestRender();
    }
    if (!typing && !this.onNewRow && /^[1-9]$/.test(data)) {
      const q = openQuestion(this.messages);
      const n = Number(data);
      if (q?.options?.length && n <= q.options.length) return this.answer(q, n);
    }
    if (matchesKey(data, Key.enter)) {
      if (this.onNewRow) return this.create();
      if (typing || this.pending.length) return this.submit();
      if (this.linkIdx >= 0) {
        const t = this.targets()[this.linkIdx];
        if (t) this.openLink(t);
      }
      return;
    }
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  /** Move the selection through the agents and the "+ New agent" row; the right side follows. */
  select(n: number): void {
    const next = Math.min(Math.max(0, n), this.agents.length);
    if (next !== this.sel) {
      this.sel = next;
      this.selName = this.agents[next]?.name ?? null;
      this.messages = [];
      this.loadedFor = "";
      this.scroll = Number.MAX_SAFE_INTEGER;
      this.linkIdx = -1;
      this.overlay = null;
      void this.refresh();
    }
    this.tui.requestRender();
  }

  private scrollBy(d: number): void {
    const cur = this.scroll === Number.MAX_SAFE_INTEGER ? this.lastTop : this.scroll;
    this.scroll = Math.max(0, cur + d);
    if (this.scroll >= this.lastMax) this.scroll = Number.MAX_SAFE_INTEGER;
    if (this.scroll === 0 && d < 0) void this.loadOlder();
    this.tui.requestRender();
  }

  private attach(files: PendingAttachment[]): void {
    for (const f of files) if (!this.pending.some((p) => p.path === f.path)) this.pending.push(f);
    this.say(`Attached ${files.map((f) => f.name).join(", ")}. It goes with your next message.`, "ok");
  }

  private async answer(q: Message, n: number): Promise<void> {
    const a = this.agent;
    if (!a || this.onNewRow) return;
    await this.c.call("answer", { name: a.name, questionId: q.id, choice: n });
    this.say(`Answered: ${q.options![n - 1]}`, "ok");
    this.scroll = Number.MAX_SAFE_INTEGER;
    await this.refresh();
  }

  private async submit(): Promise<void> {
    const a = this.agent;
    if (!a || this.onNewRow) return;
    let text = this.input.getValue().trim();
    // A message that is only paths to existing files sends those files.
    if (text && !this.pending.length) {
      const files = pastedFiles(text);
      if (files) {
        this.pending.push(...files);
        text = "";
      }
    }
    if (!text && !this.pending.length) return;
    const sent = this.pending;
    this.input.setValue("");
    this.pending = [];
    this.tui.requestRender();
    try {
      await this.c.call("send", sent.length ? { name: a.name, text, attachments: sent.map((p) => p.path) } : { name: a.name, text });
    } catch (e) {
      // Put it back, so nothing typed is ever lost to an error.
      setText(this.input, text);
      this.pending = sent;
      throw e;
    }
    this.scroll = Number.MAX_SAFE_INTEGER;
    await this.refresh();
  }

  private async create(): Promise<void> {
    const name = this.input.getValue().trim();
    const err = name ? validateName(name) : "Type a name for the agent first.";
    if (err) return this.say(err, "err");
    if (this.agents.some((a) => a.name === name)) return this.say(`There's already an agent called ${name}.`, "err");
    await this.c.call("new", { name });
    this.input.setValue("");
    this.agents = (await this.get<AgentSummary[]>("agents")) ?? [];
    this.sel = Math.max(0, this.agents.findIndex((a) => a.name === name));
    this.selName = name;
    this.loadedFor = "";
    this.say(`Created ${name}. Now tell it what it's for.`, "ok");
    await this.refresh();
  }

  openLink(target: string): void {
    const note = this.opener(target);
    if (note) this.say(note, "info");
  }

  /** Everything Ctrl+L steps through: each message's links, then its files, in order. */
  private targets(): string[] {
    return this.messages.flatMap((m) => [...(m.links ?? []).map((l) => l.target), ...(m.attachments ?? []).map((x) => x.path)]);
  }

  /** Steps from the newest link backwards, since the newest is what you usually want. */
  private nextLink(): void {
    const n = this.targets().length;
    if (!n) return this.say("There are no links or files in these messages.", "info");
    this.linkIdx = this.linkIdx <= 0 ? n - 1 : this.linkIdx - 1;
    this.tui.requestRender();
  }

  // ---------- actions ----------

  private needAgent(): AgentSummary | undefined {
    if (!this.agent || this.onNewRow) {
      this.say("Select an agent first.", "info");
      return undefined;
    }
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
      this.say(`Stopped ${a.name}. Its folder and messages are kept.`, "ok");
    }
    await this.refresh();
  }

  private confirmArchive(): void {
    const a = this.needAgent();
    if (!a) return;
    this.show({
      kind: "confirm",
      title: `Archive ${a.name}?`,
      body: [`${a.name} stops for good and its folder moves to ${tilde(paths.archiveDir())}/.`, "", muted("Nothing is deleted. You can move the folder back later.")],
      yes: "Archive",
      danger: true,
      focus: 1, // the safe choice is selected first
      run: async () => {
        await this.c.call("archive", { name: a.name });
        this.say(`Archived ${a.name}.`, "ok");
        await this.refresh();
      },
    });
  }

  private show(o: Overlay): void {
    this.overlay = o;
    this.tui.requestRender();
  }

  // ---------- settings ----------

  private async showSettings(): Promise<void> {
    if (!this.needAgent()) return;
    const o: SettingsOverlay = { kind: "settings", data: null, extra: null, idx: 0 };
    this.overlay = o;
    this.tui.requestRender();
    await this.loadSettings(o);
    o.idx = this.settingsRows(o).findIndex((r) => !!(r.field || r.run));
    this.tui.requestRender();
  }

  private async loadSettings(o: SettingsOverlay): Promise<void> {
    const a = this.agent;
    if (!a) return;
    try {
      o.data = await this.get<AgentSettingsView>("settings", { name: a.name });
      o.error = undefined;
    } catch (e) {
      o.error = friendly(e);
    }
    try {
      o.extra = await this.get("agent", { name: a.name });
    } catch {}
  }

  private settingsRows(o: SettingsOverlay): SettingsRow[] {
    const a = this.agent!;
    const d = o.data;
    const cost = d?.costReported ?? a.costReported;
    const rows: SettingsRow[] = [
      { label: "Runs on", heading: true },
      { label: "Backend", field: "backend", value: d?.backend ?? a.backend },
      { label: "Model", field: "model", value: (d ? d.model : a.model) ?? "default", note: (d ? d.model : a.model) ? "" : "the backend's choice" },
      { label: "Budget", heading: true },
      { label: "Daily budget", field: "budget", value: `$${fmtMoney(d?.dailyBudgetUsd ?? a.budgetUsd)} a day`, note: cost ? `$${(d?.spentUsd ?? a.spentUsd).toFixed(2)} spent today` : "this backend doesn't report cost" },
      { label: "Token budget", field: "tokens", value: d?.dailyTokenBudget ? `${fmtTokens(d.dailyTokenBudget)} a day` : "none", note: `${fmtTokens(d?.tokensToday ?? a.tokensToday)} used today`.replace(" tokens", "") },
      { label: "Work", heading: true },
      { label: "Workspace", field: "workspace", value: tilde(d?.workspace ?? a.dir), note: d && !d.workspaceIsDefault ? "where its work lives" : "its own folder" },
      {
        label: "Protected",
        field: "protect",
        // An older background process doesn't send these: treat them as empty rather than crash.
        value: d ? (d.protect?.length ? d.protect.map(tilde).join(", ") : "nothing") : "…",
        note: d?.protect?.length ? "read-only for it" : "full access",
      },
      { label: "Control", heading: true },
      { label: "Wake now", stay: true, run: () => this.wake() },
      { label: a.status === "stopped" ? "Start" : "Stop", stay: true, note: a.status === "stopped" ? "it carries on from where it was" : "keeps its folder and messages", run: () => this.toggleStop() },
      { label: "Archive…", danger: true, run: () => this.confirmArchive() },
      { label: "Files", heading: true },
      { label: "Open its folder", note: tilde(a.dir), stay: true, run: () => this.openLink(a.dir) },
      { label: "AGENT.md", note: "who it is, its job and rules", stay: true, run: () => this.openLink(join(a.dir, "AGENT.md")) },
      { label: "Transcripts", note: "everything it was sent and did", stay: true, run: () => this.openLink(join(paths.meta(a.name), "runs")) },
    ];
    const x = o.extra;
    if (x?.schedule) {
      rows.push({ label: "Schedule", heading: true });
      rows.push({ label: x.schedule.wakeAt ? `Wakes ${when(x.schedule.wakeAt)}` : "No wake-up set", note: x.schedule.wakeReason ?? undefined });
      for (const l of x.schedule.loops ?? []) rows.push({ label: `Every ${everyText(l.everyMs)}`, note: l.task });
      for (const m of x.monitors ?? []) rows.push({ label: "Watching", note: `${m.why} · ${m.run}` });
      const running = (x.helpers ?? []).filter((h: any) => h.status === "running");
      if (running.length) rows.push({ label: `${running.length} helper${running.length === 1 ? "" : "s"} running`, note: running.map((h: any) => h.task.split("\n")[0]).join("; ") });
      for (const b of x.background ?? []) rows.push({ label: "In the background", note: `pid ${b.pid} · ${b.command}` });
    }
    return rows;
  }

  private moveSettings(d: number): void {
    const o = this.overlay;
    if (o?.kind !== "settings" || o.editing) return;
    const rows = this.settingsRows(o);
    for (let i = o.idx + d; i >= 0 && i < rows.length; i += d) {
      if (rows[i].field || rows[i].run) {
        o.idx = i;
        break;
      }
    }
    this.tui.requestRender();
  }

  private async activateSetting(o: SettingsOverlay, row: SettingsRow): Promise<void> {
    if (row.run) {
      if (!row.stay) this.overlay = null;
      await row.run();
      if (row.stay && this.overlay === o) await this.loadSettings(o);
      return this.tui.requestRender();
    }
    if (row.field === "backend") return this.showBackendPicker(true);
    if (row.field === "model") return this.showModelPicker(this.agent!, o.data?.backend ?? this.agent!.backend, true);
    if (row.field) {
      o.editing = row.field;
      o.error = undefined;
      const d = o.data;
      const v = row.field === "protect" ? (d?.protectOwn ?? []).map(tilde).join(", ") : row.field === "budget" ? fmtMoney(d?.dailyBudgetUsd ?? this.agent!.budgetUsd) : row.field === "tokens" ? (d?.dailyTokenBudget ? String(d.dailyTokenBudget) : "") : d && !d.workspaceIsDefault ? tilde(d.workspace) : "";
      setText(this.fieldInput, v);
      this.tui.requestRender();
    }
  }

  private async saveField(o: SettingsOverlay): Promise<void> {
    const a = this.agent!;
    const raw = this.fieldInput.getValue().trim();
    const patch: Record<string, unknown> = { name: a.name };
    const bad = (msg: string) => {
      o.error = msg;
      this.tui.requestRender();
    };
    if (o.editing === "budget") {
      const n = Number(raw.replace(/^\$/, "").replace(/\s*(a|per)\s*day$/i, ""));
      if (!raw || !Number.isFinite(n) || n < 0) return bad("Type a number of dollars per day, like 10 or 2.50.");
      patch.dailyBudgetUsd = n;
    } else if (o.editing === "tokens") {
      if (!raw || /^(none|off|no)$/i.test(raw)) patch.dailyTokenBudget = null;
      else {
        const m = /^([\d.]+)\s*([km])?$/i.exec(raw.replace(/[,_]/g, ""));
        const n = m ? Number(m[1]) * (m[2]?.toLowerCase() === "m" ? 1e6 : m[2]?.toLowerCase() === "k" ? 1e3 : 1) : NaN;
        if (!Number.isFinite(n) || n <= 0) return bad("Type a number of tokens, like 500k or 2m, or leave it empty for none.");
        patch.dailyTokenBudget = Math.round(n);
      }
    } else if (o.editing === "protect") {
      if (!raw || /^(none|nothing)$/i.test(raw)) patch.protect = null;
      else {
        const list = raw.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).map((x) => (x === "~" || x.startsWith("~/") ? homedir() + x.slice(1) : x));
        const rel = list.find((x) => !x.startsWith("/"));
        if (rel) return bad(`Give full paths, like ~/Documents (not "${rel}").`);
        patch.protect = list;
      }
    } else if (o.editing === "workspace") {
      if (!raw || /^default$/i.test(raw)) patch.workspace = null;
      else {
        const p = raw === "~" || raw.startsWith("~/") ? homedir() + raw.slice(1) : raw;
        if (!p.startsWith("/")) return bad("Give a full path, like ~/code/my-repo.");
        if (!existsSync(p) || !statSync(p).isDirectory()) return bad(`There's no folder at ${tilde(p)}.`);
        patch.workspace = p;
      }
    }
    await this.c.call("set", patch);
    const label = FIELD_LABEL[o.editing!];
    o.editing = undefined;
    o.error = undefined;
    this.say(`${label} saved. It applies from ${a.name}'s next session.`, "ok");
    await this.loadSettings(o);
    await this.refresh();
  }

  private async showBackendPicker(fromSettings: boolean): Promise<void> {
    const a = this.needAgent();
    if (!a) return;
    let status: { name: string; missing: string | null }[] = [];
    try {
      status = cleanDeep(await this.c.call<{ name: string; missing: string | null }[]>("backendStatus"));
    } catch {
      // An older background process: names only.
      try {
        status = cleanDeep(await this.c.call<string[]>("backends")).map((name) => ({ name, missing: null }));
      } catch {}
    }
    if (!status.length) status = ["claude", "codex", "gemini", "opencode"].map((name) => ({ name, missing: null }));
    if (!status.some((b) => b.name === a.backend)) status.unshift({ name: a.backend, missing: null });
    const backends = status.map((b) => b.name);
    const items: PickItem[] = status.map((b) => ({
      label: b.name,
      current: b.name === a.backend,
      note: b.missing ? "not installed" : undefined,
      run: b.missing ? () => this.say(b.missing!, "err") : () => this.showModelPicker(a, b.name, fromSettings),
    }));
    this.show({ kind: "pick", title: `${a.name} runs on`, items, idx: Math.max(0, backends.indexOf(a.backend)), back: fromSettings });
  }

  private async showModelPicker(a: AgentSummary, backend: string, fromSettings: boolean): Promise<void> {
    const title = `${backend} models for ${a.name}`;
    this.show({ kind: "pick", title, items: [], idx: 0, loading: `Asking ${backend} which models it offers…`, back: fromSettings });
    let models: { id: string; name: string }[] = [];
    try {
      models = cleanDeep(await this.c.call("models", { backend }, 90_000)) ?? [];
    } catch (e) {
      if (this.overlay?.kind === "pick" && this.overlay.title === title) this.say(`Couldn't get ${backend}'s models: ${friendly(e)}`, "err");
    }
    if (this.overlay?.kind !== "pick" || this.overlay.title !== title) return; // closed meanwhile
    const same = backend === a.backend;
    const apply = (model: string | null) => async () => {
      await this.c.call("set", { name: a.name, backend, model }, 120_000);
      this.say(`${a.name} will use ${backend} · ${model ?? "its default model"} from its next session.`, "ok");
      await this.refresh();
      if (fromSettings) await this.showSettings();
    };
    const hasDefault = models.some((m) => m.id === "default");
    const items: PickItem[] = hasDefault ? [] : [{ label: "Default", note: same && !a.model ? "current" : `whatever ${backend} picks`, current: same && !a.model, run: apply(null) }];
    for (const m of models) {
      const isDefault = m.id === "default";
      const cur = same && (isDefault ? !a.model || a.model === "default" : a.model === m.id);
      const label = m.name || m.id;
      items.push({ label, note: cur ? "current" : label.toLowerCase() !== m.id.toLowerCase() && !isDefault ? m.id : undefined, current: cur, run: apply(isDefault ? null : m.id) });
    }
    if (!models.length) items.push({ label: `${backend} didn't list its models, so it uses its own default.`, info: true });
    const cur = items.findIndex((i) => i.current);
    this.overlay = { kind: "pick", title, items, idx: cur >= 0 ? cur : 0, back: fromSettings };
    this.tui.requestRender();
  }

  private movePick(d: number): void {
    const o = this.overlay;
    if (o?.kind !== "pick") return;
    for (let i = o.idx + d; i >= 0 && i < o.items.length; i += d) {
      if (!o.items[i].info) {
        o.idx = i;
        break;
      }
    }
    this.tui.requestRender();
  }

  private async overlayKey(data: string): Promise<void> {
    const o = this.overlay!;
    if (o.kind === "settings" && o.editing) {
      if (matchesKey(data, Key.escape)) {
        o.editing = undefined;
        o.error = undefined;
      } else if (matchesKey(data, Key.enter)) await this.saveField(o);
      else this.fieldInput.handleInput(data);
      return this.tui.requestRender();
    }
    const closeKey = matchesKey(data, Key.escape) || (o.kind === "settings" && (matchesKey(data, Key.tab) || matchesKey(data, Key.ctrl("p")) || matchesKey(data, Key.left)));
    if (closeKey) {
      this.overlay = null;
      if (o.kind === "pick" && o.back) return this.showSettings();
      return this.tui.requestRender();
    }
    if (o.kind === "help") {
      this.overlay = null;
      return this.tui.requestRender();
    }
    if (o.kind === "confirm") {
      if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || matchesKey(data, Key.tab)) o.focus = o.focus === 0 ? 1 : 0;
      else if (data === "y" || data === "Y" || (matchesKey(data, Key.enter) && o.focus === 0)) {
        this.overlay = null;
        await o.run();
      } else if (data === "n" || data === "N" || matchesKey(data, Key.enter)) this.overlay = null;
      return this.tui.requestRender();
    }
    if (o.kind === "settings") {
      if (matchesKey(data, Key.up)) return this.moveSettings(-1);
      if (matchesKey(data, Key.down)) return this.moveSettings(1);
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
        const row = this.settingsRows(o)[o.idx];
        if (row) await this.activateSetting(o, row);
      } else if (matchesKey(data, Key.ctrl("r"))) await this.wake();
      else if (matchesKey(data, Key.ctrl("s"))) await this.toggleStop();
      return this.tui.requestRender();
    }
    if (o.kind === "pick") {
      if (matchesKey(data, Key.up)) return this.movePick(-1);
      if (matchesKey(data, Key.down)) return this.movePick(1);
      if (matchesKey(data, Key.enter)) {
        const it = o.items[o.idx];
        if (it?.run) {
          this.overlay = null;
          await it.run();
        }
      }
      return this.tui.requestRender();
    }
  }

  quit(): void {
    this.tui.stop();
    this.c.close();
    this.onQuit();
  }

  // ---------- rendering ----------

  render(width: number): string[] {
    this.hits = [];
    const rows = Math.max(8, this.term.rows);
    const chipsH = this.pending.length && !this.onNewRow ? 1 : 0;
    const composerH = rows >= 16 ? 3 : 1;
    const bodyH = Math.max(1, rows - TOP - chipsH - composerH - 1);
    const narrow = width < NARROW;
    const leftW = narrow ? 0 : Math.min(34, Math.max(26, Math.floor(width * 0.26)));
    const rightW = narrow ? width : width - leftW - 1;
    this.leftW = leftW;

    const out: string[] = Array(TOP).fill("");
    const left = narrow ? [] : this.renderAgents(leftW, bodyH);
    const right = this.renderRight(rightW, bodyH, narrow ? 0 : leftW + 1, narrow);
    for (let i = 0; i < bodyH; i++) {
      const r = right[i] ?? "";
      const lp = narrow ? "" : fit(left[i] ?? "", leftW) + faint("│");
      out.push(typeof r === "string" ? lp + fit(r, rightW) : lp + "    " + r.image);
    }
    if (chipsH) out.push(this.renderChips(width, TOP + bodyH));
    out.push(...this.renderComposer(width, composerH));
    out.push(fit(this.renderFooter(width), width));
    return out;
  }

  /** The first row of the agent list: the name of the app, and what needs you across all agents. */
  private renderBrand(w: number): string {
    const title = ` ${accent("◆")} ${bold("overtime")}`;
    if (!this.connected) return spread(title, red("offline") + " ", w);
    const working = this.agents.filter((a) => a.status === "working").length;
    const needs = this.agents.reduce((n, a) => n + a.waiting, 0);
    const right = needs ? yellow(`${needs} need${needs === 1 ? "s" : ""} you`) : working ? accent(`${working} working`) : "";
    return spread(title, right + " ", w);
  }

  private agentDetail(a: AgentSummary): string {
    const p = statusParts(a);
    if (a.status === "working") return this.mainLive(a.name)?.step || a.activity || p.detail;
    return p.detail;
  }

  private renderAgents(w: number, h: number): string[] {
    const lines: string[] = [this.renderBrand(w), ""];
    const per = 3;
    const count = this.agents.length + 1;
    const visible = Math.max(1, Math.floor((h - 3) / per));
    const start = Math.max(0, Math.min(this.sel - Math.floor(visible / 2), count - visible));
    for (let idx = start; idx < Math.min(count, start + visible); idx++) {
      const on = idx === this.sel;
      const row = TOP + lines.length;
      const pick = () => {
        this.overlay = null;
        this.select(idx);
      };
      this.hits.push({ row, x0: 0, x1: w, act: pick }, { row: row + 1, x0: 0, x1: w, act: pick });
      const bar = on ? accent("▌") : " ";
      if (idx === this.agents.length) {
        lines.push(this.selRow(`${bar} ${accent(on ? bold("+ New agent") : "+ New agent")}`, w, on), this.selRow(`${bar}   ${muted("create one")}`, w, on), "");
        continue;
      }
      const a = this.agents[idx];
      const badge = a.waiting ? yellow(bold(`${a.waiting}`)) : a.unread ? accent(`${a.unread}`) : "";
      const p = statusParts(a);
      const detail = this.agentDetail(a);
      const l1 = bar + " " + spread(on ? bold(a.name) : a.name, badge + " ", w - 2);
      const l2 = bar + "   " + fit(`${p.color(p.dot)} ${muted(p.word + (detail ? ` · ${detail}` : ""))}`, w - 4);
      lines.push(this.selRow(l1, w, on), this.selRow(l2, w, on), "");
    }
    if (count > visible) lines.push(muted(`   ${Math.min(this.sel + 1, count)} of ${count}`));
    return lines;
  }

  /** The selected row: the accent bar always; a soft tint too when the terminal's colours are known. */
  private selRow(line: string, w: number, on: boolean): string {
    return on && hasTints() ? selected(line, w) : line;
  }

  private renderRight(w: number, h: number, x: number, narrow: boolean): Line[] {
    if (this.onNewRow) return this.renderNew(w, narrow);
    const a = this.agent!;
    const head = this.renderAgentHeader(a, w, x, narrow);
    const bodyH = Math.max(1, h - head.length);
    let body: Line[];
    if (this.overlay?.kind === "settings") body = this.renderSettings(this.overlay, w, x, TOP + head.length, bodyH);
    else if (this.overlay) body = this.renderOverlay(w, bodyH, x, TOP + head.length);
    else body = this.renderMessages(a, w, bodyH, x, TOP + head.length);
    return [...head, ...body.slice(0, bodyH)];
  }

  private renderNew(w: number, narrow: boolean): Line[] {
    const pad = (s: string) => "   " + s;
    const wrap = (s: string) => wrapTextWithAnsi(s, Math.max(20, Math.min(72, w - 6))).map(pad);
    const name = this.input.getValue().trim();
    const err = name ? (validateName(name) ?? (this.agents.some((a) => a.name === name) ? `There's already an agent called ${name}.` : null)) : null;
    const lines: Line[] = [""];
    if (narrow && this.agents.length) lines.push(pad(muted(`↑ your ${this.agents.length} agent${this.agents.length === 1 ? " is" : "s are"} above`)), "");
    if (!this.agents.length) {
      lines.push(pad(bold("Welcome to Overtime")), "");
      lines.push(...wrap("Overtime runs agents that keep working on their own. Each one has a name, a folder and a job. You brief it once; it plans, works, keeps notes, and messages you here when it has something for you or needs you."), "");
    } else lines.push(pad(bold("New agent")), "");
    lines.push(pad(`${accent("1")}  Type a name below and press ${bold("Enter")}.`));
    lines.push(pad(`${accent("2")}  Tell it what it's for, in plain words.`));
    lines.push(pad(`${accent("3")}  It writes down its job and gets started.`), "");
    if (name) lines.push(...(err ? wrap(red(err)) : [pad(`${accent("✓")} ${muted(`Press Enter to create ${name}.`)}`)]));
    else lines.push(pad(muted("Lowercase letters, digits and dashes, e.g. repo-keeper.")));
    lines.push("", ...wrap(muted("Agents keep running when you close this window. Press ? for keys.")));
    return lines;
  }

  private renderAgentHeader(a: AgentSummary, w: number, x: number, narrow: boolean): string[] {
    const p = statusParts(a);
    const detail = this.agentDetail(a);
    const state = `${p.color(`${p.dot} ${p.word}`)}${detail ? muted(` · ${detail}`) : ""}`;
    const open = this.overlay?.kind === "settings";
    const btn = open ? inverse(" Settings ") : `${muted("⚙")} Settings ${muted("→")}`;
    const btnW = visibleWidth(btn) + 1;
    this.hits.push({ row: TOP, x0: x + w - btnW, x1: x + w, act: () => (open ? ((this.overlay = null), this.tui.requestRender()) : this.showSettings()) });
    const where = narrow && this.agents.length > 1 ? muted(`  ${this.sel + 1}/${this.agents.length} ↑↓`) : "";
    const lines = [spread(`  ${bold(a.name)}${where}  ${state}`, btn + " ", w)];
    const doing = a.activity && a.status !== "new" && a.status !== "working" && !/^(paused|stopped|resting|resuming|waiting for its job)/.test(a.activity) ? italic(muted(a.activity)) : "";
    lines.push(spread(`  ${doing}`, muted(`${money(a)}  ·  ${a.backend}${a.model ? ` · ${a.model}` : ""}`) + " ", w));
    if (a.lastError && a.status !== "working") lines.push(fit(`  ${red("Last turn failed:")} ${muted(a.lastError)}`, w));
    lines.push(faint("─".repeat(w)));
    return lines;
  }

  /** The DM: the agent's words plain, yours on a tinted panel with a bar, questions and alerts as cards. */
  private renderMessages(a: AgentSummary, w: number, h: number, x: number, top: number): Line[] {
    const body: Line[] = [];
    const bodyHits: { line: number; act: () => void | Promise<void> }[] = [];
    const inner = Math.max(12, w - 6);
    const wrap = (s: string, width = inner) => (s.trim() ? wrapTextWithAnsi(s, Math.max(8, width)) : [""]);
    const paras = (s: string, width = inner) => s.split("\n").flatMap((p) => wrap(p, width));
    const q = openQuestion(this.messages);
    let t = 0;
    let lastDay = "";
    let prev: Message | undefined;
    let lastStart = 0;
    let questionStart = -1;

    if (this.hasMore) body.push(muted("   ↑ older messages: PgUp at the top loads them"), "");
    if (!this.messages.length) body.push("", muted(`   No messages with ${a.name} yet.`));

    for (const m of this.messages) {
      const day = new Date(m.t).toDateString();
      if (day !== lastDay) {
        const label = day === new Date().toDateString() ? "Today" : day === new Date(Date.now() - 86400000).toDateString() ? "Yesterday" : new Date(m.t).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
        const side = Math.max(2, Math.floor((w - label.length - 2) / 2));
        if (body.length) body.push("");
        body.push(faint("─".repeat(side)) + " " + muted(label) + " " + faint("─".repeat(Math.max(0, w - side - label.length - 2))), "");
        lastDay = day;
        prev = undefined;
      }
      lastStart = body.length;
      const regroup = !prev || prev.from !== m.from || prev.kind !== "message" || m.kind !== "message" || new Date(m.t).getTime() - new Date(prev.t).getTime() > REGROUP_MIN * 60_000;

      if (m.from === "you") {
        // Yours: a tinted panel behind an accent bar, like Grok CLI's prompt blocks.
        const row = (s: string) => accent("┃") + (hasTints() ? panel(" " + s, w - 2) : " " + s);
        if (prev && body.at(-1) !== "") body.push("");
        body.push(row(spread(m.replyTo ? muted("answered") : "", muted(stamp(m.t)) + " ", w - 3)));
        if (m.text) for (const l of paras(m.text, w - 6)) body.push(row(" " + l));
        t = this.pushExtras(m, body, bodyHits, w, t, (s) => row(" " + s));
        body.push(row(""), "");
      } else if (m.kind === "question") {
        const open = q?.id === m.id;
        const line = (s: string) => `  ${open ? yellow("┃") : faint("┃")} ${s}`;
        if (body.length && body.at(-1) !== "") body.push("");
        if (open) questionStart = body.length;
        const hq = headed(m, "A question for you");
        body.push(line(`${open ? yellow(bold("?")) : muted("?")} ${open ? bold(hq.title) : muted(hq.title)}  ${muted(stamp(m.t))}`));
        if (hq.body) for (const l of paras(md(hq.body), inner - 4)) body.push(line(l));
        if (m.why) for (const l of paras(muted(`Why it matters: ${m.why}`), inner - 4)) body.push(line(l));
        if (m.recommendation) for (const l of paras(`${bold("Recommended:")} ${m.recommendation}`, inner - 4)) body.push(line(l));
        if (m.options?.length) {
          body.push(line(""));
          m.options.forEach((o, i) => {
            const n = i + 1;
            if (open) {
              bodyHits.push({ line: body.length, act: () => this.answer(m, n) });
              body.push(line(`${inverse(accent(` ${n} `))} ${o}`));
            } else body.push(line(m.answer?.choice === n ? `${accent("✓")} ${o}` : muted(`  ${o}`)));
          });
        }
        if (m.answer && (!m.answer.choice || m.answer.text !== m.options?.[m.answer.choice - 1])) for (const l of paras(muted(`You: ${m.answer.text}`), inner - 4)) body.push(line(l));
        if (open) body.push(line(""), line(muted(`Press ${m.options?.length ? (m.options.length === 1 ? "1" : `1–${m.options.length}`) + ", or " : ""}type a message to answer.`)));
        t = this.pushExtras(m, body, bodyHits, w, t, line);
        body.push("");
      } else if (m.kind === "alert") {
        const line = (s: string) => `  ${red("┃")} ${s}`;
        if (body.length && body.at(-1) !== "") body.push("");
        const ha = headed(m, "Something went wrong");
        body.push(line(`${red(bold(ha.title))}  ${muted(stamp(m.t))}${m.from === "overtime" ? muted("  · from Overtime") : ""}`));
        if (ha.body) for (const l of paras(md(ha.body), inner - 4)) body.push(line(l));
        t = this.pushExtras(m, body, bodyHits, w, t, line);
        body.push("");
      } else {
        // The agent's words, and Overtime's notes: plain text, the name only when the speaker changes.
        if (regroup) {
          if (body.length && body.at(-1) !== "") body.push("");
          body.push(`  ${m.from === "agent" ? accent(bold(a.name)) : muted(bold("Overtime"))}  ${muted(stamp(m.t))}`);
        }
        const ind = (s: string) => "  " + s;
        if (m.kind === "report" && m.title) body.push(ind(`${accent("▣")} ${bold(m.title)}`));
        const text = m.kind === "report" && m.title && m.text.startsWith(m.title) ? m.text.slice(m.title.length).trim() : m.text;
        if (text) for (const l of paras(m.from === "overtime" ? muted(text) : md(text))) body.push(ind(l));
        t = this.pushExtras(m, body, bodyHits, w, t, ind);
      }
      prev = m;
    }

    const live = this.chatLive(a.name);
    if (live) {
      if (body.length && body.at(-1) !== "") body.push("");
      body.push(`  ${accent(bold(a.name))}  ${muted(`${spinner()} ${live.step ?? (live.text ? "writing…" : "thinking…")}`)}`);
      const text = live.text.trim();
      if (text) for (const l of text.split("\n").slice(-40).flatMap((p) => wrap(p))) body.push("  " + l);
    }
    body.push("");

    const maxScroll = Math.max(0, body.length - h);
    this.lastMax = maxScroll;
    let s: number;
    if (this.scroll !== Number.MAX_SAFE_INTEGER) s = Math.min(this.scroll, maxScroll);
    // Following the newest: a last message longer than the view is shown from its start.
    // An open question is what needs you, so it is kept in view from its top.
    else if (live) s = maxScroll;
    else if (questionStart >= 0) s = Math.min(maxScroll, Math.max(0, questionStart - 1));
    else s = Math.min(maxScroll, Math.max(0, body.length - lastStart > h ? lastStart - 1 : maxScroll));
    this.lastTop = s;
    const view = body.slice(s, s + h);
    // Images only when all their rows are in view; otherwise just their file line shows.
    for (let i = 0; i < view.length; i++) {
      const v = view[i];
      if (typeof v !== "string" && i + v.rows > view.length) view[i] = "";
    }
    if (s > 0 && view.length > 1 && typeof view[0] === "string") view[0] = muted(`   ↑ ${s} line${s === 1 ? "" : "s"} above · PgUp`);
    if (s < maxScroll && view.length === h && h > 1) view[h - 1] = muted(`   ↓ newer below · PgDn`);
    for (const bh of bodyHits) {
      const row = bh.line - s;
      if (row >= 0 && row < h) this.hits.push({ row: top + row, x0: x, x1: x + w, act: bh.act });
    }
    return view;
  }

  /** A message's links, then its files (with an inline preview for images where the terminal can show one). */
  private pushExtras(m: Message, body: Line[], hits: { line: number; act: () => void }[], w: number, t: number, wrapLine: (s: string) => string): number {
    for (const l of m.links ?? []) {
      const idx = t++;
      const url = l.kind === "url" ? l.target : pathToFileURL(l.target).href;
      const label = l.kind === "url" ? l.label : tilde(l.label);
      const target = l.target;
      hits.push({ line: body.length, act: () => this.openLink(target) });
      body.push(wrapLine(idx === this.linkIdx ? inverse(` ↗ ${label} `) + muted("  Enter opens") : accent(`↗ ${link(url, underline(label))}`)));
    }
    for (const att of m.attachments ?? []) {
      const idx = t++;
      const icon = att.kind === "image" ? "🖼" : att.kind === "folder" ? "🗀" : "📎";
      const size = att.bytes != null ? muted(`  ${humanBytes(att.bytes)}`) : "";
      const path = att.path;
      hits.push({ line: body.length, act: () => this.openLink(path) });
      body.push(wrapLine(idx === this.linkIdx ? inverse(` ${icon} ${att.name} `) + muted("  Enter opens") : `${icon} ${link(pathToFileURL(path).href, underline(att.name))}${size}`));
      if (att.kind === "image") {
        const img = this.preview(path, Math.min(48, w - 8));
        if (img) {
          body.push(img);
          for (let i = 1; i < img.rows; i++) body.push("");
        }
      }
    }
    return t;
  }

  /** An inline image, for terminals that can show one (kitty, iTerm2, WezTerm, Ghostty). Never throws. */
  private preview(path: string, cols: number): { image: string; rows: number } | null {
    try {
      if (!getCapabilities().images) return null;
      let c = this.images.get(path);
      if (c === undefined) {
        c = null;
        const ext = extname(path).toLowerCase();
        const mime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : null;
        if (mime && existsSync(path) && statSync(path).size <= 5 * 1024 * 1024) {
          const b64 = readFileSync(path).toString("base64");
          const dim = getImageDimensions(b64, mime);
          if (dim) c = { b64, w: dim.widthPx, h: dim.heightPx };
        }
        this.images.set(path, c);
      }
      if (!c) return null;
      const r = renderImage(c.b64, { widthPx: c.w, heightPx: c.h }, { maxWidthCells: cols, maxHeightCells: 12, preserveAspectRatio: true });
      return r ? { image: r.sequence, rows: Math.max(1, r.rows) } : null;
    } catch {
      return null;
    }
  }

  /** Every panel (settings, pickers, help, confirmations) is a framed box on top of the conversation. */
  private framed(title: string, body: string[], bodyHits: { line: number; x0?: number; x1?: number; act: () => void | Promise<void> }[], w: number, x: number, top: number): Line[] {
    const indent = w < 50 ? 1 : 2;
    const bw = Math.max(20, Math.min(w - indent * 2, 92));
    for (const hh of bodyHits) {
      this.hits.push({ row: top + 2 + hh.line, x0: x + indent + 2 + (hh.x0 ?? 0), x1: hh.x1 != null ? x + indent + 2 + hh.x1 : x + indent + bw - 2, act: hh.act });
    }
    return ["", ...box(title, body, bw).map((l) => " ".repeat(indent) + l)];
  }

  /** The inside width of a framed panel in a pane of width w. */
  private innerW(w: number): number {
    const indent = w < 50 ? 1 : 2;
    return Math.max(20, Math.min(w - indent * 2, 92)) - 4;
  }

  private renderSettings(o: SettingsOverlay, w: number, x: number, top: number, h: number): Line[] {
    const title = `${this.agent?.name ?? ""} · settings`;
    const iw = this.innerW(w);
    if (!o.data && !o.error) return this.framed(title, ["", muted(`${spinner()} Loading settings…`), ""], [], w, x, top);
    const rows = this.settingsRows(o);
    const labelW = 16;
    let valueW = Math.min(30, Math.max(12, ...rows.filter((r) => r.field).map((r) => visibleWidth(r.value ?? "") + 2)));
    // Explanations only where they fit whole-ish; a narrow panel shows clean values instead of fragments.
    const notes = iw - 2 - labelW - valueW >= 14;
    if (!notes) valueW = Math.max(8, iw - 2 - labelW);
    const body: string[] = [];
    const lineOf: number[] = [];
    rows.forEach((r, i) => {
      if (r.heading) {
        body.push("", muted(r.label.toUpperCase()));
        return;
      }
      const on = i === o.idx;
      lineOf[i] = body.length;
      if (r.field && o.editing === r.field) {
        this.fieldInput.focused = true;
        const fw = Math.max(8, Math.min(44, iw - labelW - 2));
        const field = this.fieldInput.render(fw - 2)[0] ?? "";
        body.push(accent("› ") + bold(fit(r.label, labelW)) + (hasTints() ? element(" " + field, fw) : accent("[") + fit(field, fw - 2) + accent("]")));
        if (o.error) body.push("  " + " ".repeat(labelW) + red(o.error));
        return;
      }
      // Every row has the same two-column gutter, so the selected one doesn't shift.
      const gutter = on ? accent("› ") : "  ";
      const label = fit(on ? bold(r.label) : r.danger ? red(r.label) : r.label, labelW);
      let line: string;
      if (r.field) line = label + fit(on ? accent(r.value ?? "") : (r.value ?? ""), valueW - 2) + (notes ? "  " + muted(r.note ?? "") : "");
      else if (r.run) line = (r.danger ? (on ? bold(red(r.label)) : red(r.label)) : on ? bold(r.label) : r.label) + (r.note && notes ? muted(`  ·  ${r.note}`) : "");
      else line = fit(muted(r.label), labelW) + muted(r.note ?? "");
      line = fit(gutter + line, iw);
      body.push(on && hasTints() ? selected(line, iw) : line);
    });
    if (o.error && !o.editing) body.push("", "  " + red(o.error));
    body.push("");
    // Keep the selected row in view.
    const bh = Math.max(3, h - 3);
    const selLine = lineOf[o.idx] ?? 0;
    const start = Math.max(0, Math.min(selLine - Math.floor(bh / 2), body.length - bh));
    const hits: { line: number; act: () => Promise<void> }[] = [];
    rows.forEach((r, i) => {
      if (!(r.field || r.run) || lineOf[i] == null) return;
      const line = lineOf[i] - start;
      if (line >= 0 && line < bh)
        hits.push({
          line,
          act: async () => {
            o.idx = i;
            await this.activateSetting(o, r);
          },
        });
    });
    const shown = body.slice(start, start + bh);
    // Say when there's more than fits, rather than cutting it off silently.
    if (start + bh < body.length) shown[shown.length - 1] = muted("  ↓ more below");
    if (start > 0) shown[0] = muted("  ↑ more above");
    return this.framed(title, shown, hits.filter((hh) => hh.line > (start > 0 ? 0 : -1) && hh.line < (start + bh < body.length ? bh - 1 : bh)), w, x, top);
  }

  private renderOverlay(w: number, h: number, x: number, top: number): Line[] {
    const o = this.overlay!;
    const iw = this.innerW(w);
    if (o.kind === "help") {
      const kw = 15;
      const row = (k: string, d: string) => wrapTextWithAnsi(d, Math.max(10, iw - kw)).map((l, n) => (n === 0 ? bold(fit(k, kw)) : " ".repeat(kw)) + l);
      const body = [
        "",
        muted("MOVING AROUND"),
        ...row("↑ ↓", "move between agents, and to + New agent"),
        ...row("→ or Tab", "open the selected agent's settings"),
        ...row("← or Esc", "close a panel"),
        ...row("PgUp PgDn", "scroll the messages (or the mouse wheel)"),
        "",
        muted("MESSAGES"),
        ...row("type, Enter", "write a message and send it"),
        ...row("1–9", "answer the open question with that option"),
        ...row("drag a file", "attach it to your next message"),
        ...row("Ctrl+L", "step through links and files; Enter opens one"),
        "",
        muted("SHORTCUTS"),
        ...row("Ctrl+N", "new agent"),
        ...row("Ctrl+R", "wake the agent now"),
        ...row("Ctrl+S", "stop or start the agent"),
        ...row("Ctrl+T", "change its backend and model"),
        ...row("Ctrl+O", "open its folder"),
        ...row("Ctrl+C", "quit (your agents keep running)"),
        "",
      ];
      return this.framed("Keys", body.slice(0, Math.max(3, h - 3)), [], w, x, top);
    }
    if (o.kind === "confirm") {
      const body: string[] = [""];
      for (const l of o.body) body.push(...(l ? wrapTextWithAnsi(l, iw) : [""]));
      body.push("");
      // Buttons are the same width focused or not; the focused one is filled.
      const button = (label: string, on: boolean, danger: boolean) => {
        const t = hasTints() ? `  ${label}  ` : `[ ${label} ]`;
        if (on) return bold(inverse(danger ? red(t) : t));
        return hasTints() ? element(danger ? red(t) : t, visibleWidth(t)) : danger ? red(t) : t;
      };
      const yes = button(o.yes, o.focus === 0, !!o.danger);
      const no = button("Cancel", o.focus === 1, false);
      const line = body.length;
      body.push(`${yes}   ${no}`, "");
      const yw = visibleWidth(yes);
      const hits = [
        {
          line,
          x0: 0,
          x1: yw,
          act: async () => {
            this.overlay = null;
            await o.run();
          },
        },
        { line, x0: yw + 3, x1: yw + 3 + visibleWidth(no), act: () => ((this.overlay = null), this.tui.requestRender()) },
      ];
      return this.framed(o.title, body, hits, w, x, top);
    }
    if (o.kind !== "pick") return [];
    const body: string[] = [""];
    if (o.loading) body.push(muted(`${spinner()} ${o.loading}`), "");
    const maxRows = Math.max(3, h - 5);
    const start = Math.max(0, Math.min(o.idx - Math.floor(maxRows / 2), o.items.length - maxRows));
    const hits: { line: number; act: () => Promise<void> }[] = [];
    o.items.slice(start, start + maxRows).forEach((it, k) => {
      const i = start + k;
      if (it.info) {
        body.push(...wrapTextWithAnsi(muted(it.label), iw));
        return;
      }
      const on = i === o.idx;
      hits.push({
        line: body.length,
        act: async () => {
          this.overlay = null;
          await it.run?.();
        },
      });
      const right = it.current ? accent("✓ current") : muted(it.note ?? "");
      const line = (on ? accent("› ") : "  ") + spread(on ? bold(it.label) : it.label, right, iw - 2);
      body.push(on && hasTints() ? selected(line, iw) : line);
    });
    body.push("");
    return this.framed(o.title, body, hits, w, x, top);
  }

  private placeholder(): string {
    const o = this.overlay;
    if (o) return `Esc closes ${o.kind === "settings" ? "settings" : o.kind === "help" ? "the keys" : o.kind === "confirm" ? "this without changing anything" : "the list"}`;
    if (this.onNewRow) return "Name the new agent, e.g. repo-keeper";
    const a = this.agent;
    if (!a) return "";
    const q = openQuestion(this.messages);
    if (q?.options?.length) return `Press ${q.options.length === 1 ? "1" : `1–${q.options.length}`} to answer, or type a message`;
    if (a.status === "new") return `Tell ${a.name} what it's for…`;
    if (a.status === "stopped") return `Message ${a.name} (stopped; it reads this when started)`;
    return `Message ${a.name}  ·  drag files here to attach`;
  }

  private renderChips(w: number, row: number): string {
    let s = "  ";
    let x = 2;
    this.pending.forEach((p, i) => {
      const icon = p.kind === "image" ? "🖼" : p.kind === "folder" ? "🗀" : "📎";
      const chip = `${icon} ${p.name}${p.bytes != null ? muted(` ${humanBytes(p.bytes)}`) : ""} `;
      const cw = visibleWidth(chip);
      this.hits.push({
        row,
        x0: x + cw,
        x1: x + cw + 2,
        act: () => {
          this.pending.splice(i, 1);
          this.tui.requestRender();
        },
      });
      s += chip + muted("✕") + "   ";
      x += cw + 4;
    });
    return fit(s + muted("Backspace removes the last"), w);
  }

  private renderComposer(w: number, h: number): string[] {
    const active = !this.overlay;
    this.input.focused = active;
    if (active) this.fieldInput.focused = false;
    (this.input as any).placeholder = this.placeholder();
    const inner = Math.max(4, w - 8);
    const field = active ? (this.input.render(inner)[0] ?? "") : muted(fit(this.placeholder(), inner));
    const prompt = active ? accent("›") : muted("›");
    if (h < 3) return [fit(` ${prompt} ${field}`, w)];
    // Like Grok CLI: a filled block on a tint, no border. Without tints, a quiet rounded border.
    if (hasTints()) return [element("", w), element(`  ${prompt} ${field}`, w), element("", w)];
    const c = active && this.typing() ? accent : faint;
    return [c("╭" + "─".repeat(Math.max(0, w - 2)) + "╮"), c("│") + " " + prompt + " " + fit(field, w - 6) + " " + c("│"), c("╰" + "─".repeat(Math.max(0, w - 2)) + "╯")];
  }

  private renderFooter(w: number): string {
    if (!this.connected && !this.flash) return ` ${red("✗")} ${red("Can't reach the background process. Reconnecting…")}`;
    if (this.flash) {
      const f = this.flash;
      const icon = f.tone === "ok" ? accent("✓") : f.tone === "err" ? red("✗") : accent("›");
      return ` ${icon} ${f.tone === "err" ? red(f.text) : f.text}`;
    }
    let hints: string[];
    const q = !this.onNewRow ? openQuestion(this.messages) : undefined;
    const o = this.overlay;
    if (o?.kind === "settings") hints = o.editing ? [keyHint("enter", "save"), keyHint("esc", "cancel")] : [keyHint("↑↓", "move"), keyHint("enter", "change"), keyHint("esc", "close")];
    else if (o?.kind === "help") hints = [keyHint("any key", "close")];
    else if (o?.kind === "confirm") hints = [keyHint("←→", "choose"), keyHint("enter", "confirm"), keyHint("esc", "cancel")];
    else if (o) hints = [keyHint("↑↓", "move"), keyHint("enter", "choose"), keyHint("esc", o.kind === "pick" && o.back ? "back" : "close")];
    else if (this.onNewRow) hints = [keyHint("enter", "create"), keyHint("↑↓", "agents"), keyHint("?", "keys")];
    else if (this.typing() || this.pending.length) hints = [keyHint("enter", "send"), keyHint("esc", "clear"), keyHint("↑↓", "agents")];
    else hints = [q?.options?.length ? keyHint(`1–${q.options.length}`, "answer") : "", keyHint("↑↓", "agents"), keyHint("→", "settings"), keyHint("pgup", "scroll"), this.targets().length ? keyHint("^L", "links") : "", keyHint("?", "keys")].filter(Boolean);
    const left = this.agent && !this.onNewRow ? muted(` ${this.agent.backend}${this.agent.model ? ` · ${this.agent.model}` : ""}`) : "";
    while (hints.length > 1 && visibleWidth(hints.join(sep)) + visibleWidth(left) + 3 > w) hints.pop();
    return spread(left, hints.join(sep) + " ", w);
  }
}

/** Replace an input's text with the cursor at the end, ready to keep typing (Input.setValue keeps the old cursor). */
function setText(input: Input, v: string): void {
  input.setValue(v);
  (input as any).cursor = v.length;
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

function fmtMoney(n: number): string {
  return n % 1 ? n.toFixed(2) : String(n);
}

function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}m tokens`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k tokens`;
  return `${n} tokens`;
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
  // The screen library pages its own viewport on PgUp/PgDn, but this app draws one screen and scrolls
  // the conversation itself: hand those keys to the app.
  const kb = getKeybindings();
  kb.setUserBindings({ ...kb.getUserBindings(), "tui.altScreen.pageUp": [], "tui.altScreen.pageDown": [] } as any);
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

  // Mix the palette from the terminal's real colours, so tints read right on dark and light themes.
  if (!o.terminal) {
    try {
      const colors = await (tui as any).queryTerminalColors?.({ timeoutMs: 300 });
      applyTerminalColors(colors, getCapabilities().trueColor);
      tui.requestRender(true);
    } catch {}
  }

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
