import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Editor,
  Markdown,
  type MarkdownTheme,
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
  type AutocompleteItem,
  type AutocompleteProvider,
  fuzzyFilter,
} from "@earendil-works/pi-tui";
import { ensureDaemon, isDaemonGone, type DaemonClient } from "../daemon/client.js";
import type { AgentSummary } from "../daemon/control.js";
import { validateName } from "../agent/agent.js";
import { paths } from "../paths.js";
import { pastedFiles, type PendingAttachment } from "./attach.js";
import { copyText } from "./clipboard.js";
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
  shimmer,
  cut,
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
import { headed, humanBytes, openQuestion, optionLabel, recommendedOption, type AgentSettingsView, type LiveState, type Message } from "./types.js";

export { clean, cleanDeep, openPlan } from "./style.js";
export type { LiveState, Message } from "./types.js";

// ---------- layout ----------

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const spinner = () => SPINNER[Math.floor(Date.now() / 90) % SPINNER.length];
/** Below this width the agent list is hidden; ↑↓ still switch agents. */
const NARROW = 80;
const PAGE = 10;
/** Rows above the panes: one empty row, so the first line isn't pressed against the top edge (the divider runs through it). */
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

type McpEntry = { name: string; source: "shared" | "person" | "agent"; enabled: boolean; describe: string; signedIn?: boolean };
type McpStatus = Record<string, { ok: boolean; tools: string[]; error?: string; needsSignIn?: boolean }>;
type SettingsOverlay = { kind: "settings"; data: AgentSettingsView | null; extra: any; mcp?: McpEntry[]; mcpStatus?: McpStatus; idx: number; editing?: Field; error?: string };
type Overlay =
  | null
  | { kind: "help" }
  | SettingsOverlay
  | { kind: "pick"; title: string; items: PickItem[]; idx: number; loading?: string; back?: boolean }
  | { kind: "confirm"; title: string; body: string[]; yes: string; run: () => Promise<void>; danger?: boolean; focus: 0 | 1 };

/**
 * Links and paths in a message, clickable right where they're written (underlined), instead of a
 * separate list under it. Longest first, through placeholders, so a link inside a longer one stays whole.
 */
export function linkify(text: string, links: { label: string; target: string; kind: string }[] | undefined, home = process.env.HOME): string {
  if (!links?.length) return text;
  const seen = new Set<string>();
  const sorted = links.filter((l) => l.label && !seen.has(l.label) && seen.add(l.label)).sort((a, b) => b.label.length - a.label.length);
  const slots: string[] = [];
  let out = text;
  for (const l of sorted) {
    if (!out.includes(l.label)) continue;
    const url = l.kind === "url" ? l.target : pathToFileURL(l.target).href;
    const shown = l.kind !== "url" && home && l.label.startsWith(home + "/") ? "~" + l.label.slice(home.length) : l.label;
    slots.push(link(url, underline(shown)));
    out = out.split(l.label).join(`\u0000${slots.length - 1}\u0000`);
  }
  return out.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[Number(n)]);
}

/** How Markdown from agents looks: quiet, readable in any theme, one accent colour. */
const MD_THEME: MarkdownTheme = {
  heading: (t) => bold(t),
  link: (t) => underline(accent(t)),
  linkUrl: (t) => muted(t),
  code: (t) => accent(t),
  codeBlock: (t) => t,
  codeBlockBorder: (t) => faint(t),
  quote: (t) => muted(italic(t)),
  quoteBorder: (t) => faint(t),
  hr: (t) => faint(t),
  listBullet: (t) => accent(t),
  bold: (t) => bold(t),
  italic: (t) => italic(t),
  strikethrough: (t) => `\x1b[9m${t}\x1b[29m`,
  underline: (t) => underline(t),
};

/** Markdown rendered to lines of a given width, cached per text and width (the screen redraws often). */
const mdCache = new Map<string, string[]>();
export function markdownLines(text: string, width: number): string[] {
  const key = `${width}\u0000${text}`;
  let lines = mdCache.get(key);
  if (!lines) {
    lines = new Markdown(text, 0, 0, MD_THEME, undefined, { preserveOrderedListMarkers: true }).render(Math.max(8, width)).map((l) => l.replace(/\s+$/, ""));
    while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    if (mdCache.size > 2000) mdCache.clear();
    mdCache.set(key, lines);
  }
  return lines;
}


/**
 * The message box: a multi-line editor. Enter sends; Shift+Enter or Ctrl+J starts a new line; a pasted
 * block keeps its line breaks (a long one shows as a "[paste #1 +40 lines]" marker and is sent in full).
 * It draws no border of its own: the app frames it.
 */
class Composer extends Editor {
  protected renderTopBorder(): string {
    return "";
  }
  protected renderBottomBorder(): string {
    return "";
  }
  /** The full text, with pasted blocks expanded. */
  getValue(): string {
    return this.getExpandedText();
  }
  setValue(v: string): void {
    this.setText(v);
  }
  /** Its text lines at this width, cursor included, without the (empty) borders, and the open menu's lines. */
  body(width: number): { text: string[]; menu: string[] } {
    const lines = this.render(width);
    const menu = (this as any).renderedAutocompleteHeight ?? 0;
    return { text: lines.slice(1, Math.max(2, lines.length - 1 - menu)), menu: menu ? lines.slice(lines.length - menu) : [] };
  }
}

export interface SkillInfo {
  name: string;
  description: string;
}

/**
 * Typing / at the start of a message lists the agent's skills, narrowing as you type (like Claude
 * Code's / menu). Choosing one puts "/name " in the message, for you to add to; the agent is told to
 * use that skill.
 */
export class SkillCompletion implements AutocompleteProvider {
  triggerCharacters = ["/"];
  constructor(private readonly skills: () => SkillInfo[]) {}

  async getSuggestions(lines: string[], cursorLine: number, cursorCol: number) {
    if (cursorLine !== 0) return null;
    const before = (lines[0] ?? "").slice(0, cursorCol).trimStart();
    if (!before.startsWith("/") || before.includes(" ")) return null;
    const query = before.slice(1);
    const items: AutocompleteItem[] = fuzzyFilter(this.skills(), query, (s) => s.name).map((s) => ({ value: s.name, label: `/${s.name}`, description: s.description }));
    return items.length ? { items, prefix: before } : null;
  }

  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
    const line = lines[cursorLine] ?? "";
    const start = cursorCol - prefix.length;
    const insert = `/${item.value} `;
    const next = [...lines];
    next[cursorLine] = line.slice(0, start) + insert + line.slice(cursorCol);
    return { lines: next, cursorLine, cursorCol: start + insert.length };
  }
}

const FIELD_LABEL: Record<Field, string> = { backend: "Backend", model: "Model", budget: "Daily budget", tokens: "Token budget", workspace: "Workspace", protect: "Protected paths" };

/** The whole screen: agents on the left like DMs, the selected agent's messages on the right, a composer below. */
export class App implements Component {
  agents: AgentSummary[] = [];
  /** The selected agent's skills, for the / menu. */
  skills: SkillInfo[] = [];
  private skillsFor = "";
  private skillsAt = 0;
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
  input: Composer;
  /** An option picked with a number key, waiting for Enter (so one stray key never answers). */
  choosing: { id: string; n: number } | null = null;
  fieldInput = new Input({ prompt: "", placeholderStyle: muted });
  pending: PendingAttachment[] = [];
  connected = true;
  live = new Map<string, LiveState>();
  private hits: Hit[] = [];
  private inflight: Promise<void> | null = null;
  private again = false;
  private flashTimer: NodeJS.Timeout | null = null;
  private lastMax = 0;
  /** Where the link picked with Ctrl+L was drawn, so the view can bring it into sight. */
  private linkLine = -1;
  /**
   * Where the view jumps once (an open question when you arrive, or the start of a new message), after
   * which it stays wherever you scroll. Applying it on every frame would pull the view back as you scroll.
   */
  private anchor: "question" | "last" | null = "question";
  private lastTop = 0;
  private leftW = 0;
  private loadedFor = "";
  private started = false;
  /** The selected agent's name (null: the "+ New agent" row). */
  private selName: string | null = null;
  private images = new Map<string, { b64: string; w: number; h: number } | null>();

  constructor(public c: DaemonClient, private readonly tui: TuiAltScreen, private readonly term: Terminal, private readonly onQuit: () => void, private readonly opener: (t: string) => string | void = openTarget) {
    this.input = new Composer(tui as any, {
      borderColor: (x: string) => x,
      selectList: { selectedPrefix: accent, selectedText: (t: string) => bold(t), description: muted, scrollInfo: muted, noMatch: muted },
    });
    // Enter is the app's to handle (send), never the editor's own submit.
    this.input.disableSubmit = true;
    this.input.setAutocompleteProvider(new SkillCompletion(() => this.skills));
  }

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
        if (this.loadedFor !== a.name) {
          this.scroll = Number.MAX_SAFE_INTEGER;
          this.anchor = "question";
        } else if (this.scroll === Number.MAX_SAFE_INTEGER && fresh.at(-1)?.id !== this.messages.at(-1)?.id) {
          // Something new while you're at the bottom: show it (from its start if it's long), once.
          this.anchor = openQuestion(fresh)?.id === fresh.at(-1)?.id ? "question" : "last";
        }
        this.messages = fresh;
        this.hasMore = !!r?.hasMore;
        // Its skills, for the / menu: when the agent changes, and every half minute (it may add some).
        if (this.skillsFor !== a.name || Date.now() - this.skillsAt > 30_000) {
          this.skills = (await this.get<SkillInfo[]>("skills", { name: a.name }).catch(() => null)) ?? [];
          this.skillsFor = a.name;
          this.skillsAt = Date.now();
        }
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
      if (isDaemonGone(e)) this.connected = false;
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
    return this.input.getText().length > 0;
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
    // The / menu is open: its keys (move, choose, close) go to it.
    if (this.input.isShowingAutocomplete() && [Key.up, Key.down, Key.enter, Key.tab, Key.escape].some((k) => matchesKey(data, k))) {
      this.input.handleInput(data);
      return this.tui.requestRender();
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.ctrl("p"))) return this.showSettings();
    const typing = this.typing();
    // → moves right, into the selected agent's settings (← or Esc comes back), as long as you aren't typing.
    if (!typing && !this.onNewRow && this.agent && matchesKey(data, Key.right)) return this.showSettings();
    if (!typing && data === "?") return this.show({ kind: "help" });

    if (matchesKey(data, Key.escape)) {
      if (typing) this.input.setValue("");
      else if (this.choosing) this.choosing = null;
      else if (this.linkIdx >= 0) this.linkIdx = -1;
      else if (this.pending.length) this.pending = [];
      return this.tui.requestRender();
    }
    // Shift+↑↓ (or Option+↑↓) scroll the messages a few lines; plain ↑↓ move between agents.
    if (matchesKey(data, Key.shift("up")) || matchesKey(data, Key.alt("up"))) return this.scrollBy(-3);
    if (matchesKey(data, Key.shift("down")) || matchesKey(data, Key.alt("down"))) return this.scrollBy(3);
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      // In a message of several lines, ↑↓ move through its lines; otherwise between agents.
      if (this.input.getLines().length > 1) {
        this.input.handleInput(data);
        return this.tui.requestRender();
      }
      return this.select(this.sel + (matchesKey(data, Key.up) ? -1 : 1));
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) return this.scrollBy(matchesKey(data, Key.pageUp) ? -PAGE : PAGE);
    if (!typing && matchesKey(data, Key.backspace) && this.pending.length) {
      this.pending.pop();
      return this.tui.requestRender();
    }
    if (!typing && !this.onNewRow && /^[0-9]$/.test(data)) {
      const q = openQuestion(this.messages);
      const n = Number(data);
      if (q && (n === 0 || (q.options?.length && n <= q.options.length))) {
        this.choosing = { id: q.id, n };
        this.scroll = Number.MAX_SAFE_INTEGER;
        this.anchor = "question"; // bring the question into view, once
        return this.tui.requestRender();
      }
    }
    if (this.choosing && !typing) {
      const q = openQuestion(this.messages);
      if (!q || q.id !== this.choosing.id) this.choosing = null;
      else if (matchesKey(data, Key.enter)) {
        const n = this.choosing.n;
        this.choosing = null;
        return n === 0 ? this.dismiss(q) : this.answer(q, n);
      } else if (matchesKey(data, Key.escape)) {
        this.choosing = null;
        return this.tui.requestRender();
      }
    }
    // Shift+Enter / Ctrl+J start a new line in the message (checked before Enter, which Ctrl+J resembles).
    // Option+Enter too: many terminals send Shift+Enter exactly like Enter.
    if (!this.onNewRow && (data === "\n" || data === "\x1b\r" || getKeybindings().matches(data, "tui.input.newLine"))) {
      this.input.handleInput("\n");
      return this.tui.requestRender();
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
      this.choosing = null;
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
    this.anchor = null; // you scrolled: no pending jump may override that
    const atBottom = this.scroll === Number.MAX_SAFE_INTEGER;
    // Already at the bottom: scrolling further down does nothing (it must never move the view up).
    if (atBottom && d > 0) return;
    const cur = atBottom ? this.lastMax : this.scroll;
    this.scroll = Math.max(0, cur + d);
    if (this.scroll >= this.lastMax) this.scroll = Number.MAX_SAFE_INTEGER;
    if (this.scroll === 0 && d < 0) void this.loadOlder();
    this.tui.requestRender();
  }

  private attach(files: PendingAttachment[]): void {
    for (const f of files) if (!this.pending.some((p) => p.path === f.path)) this.pending.push(f);
    this.say(`Attached ${files.map((f) => f.name).join(", ")}. It goes with your next message.`, "ok");
  }

  private async dismiss(q: Message): Promise<void> {
    const a = this.agent;
    if (!a || this.onNewRow) return;
    await this.c.call("dismiss", { name: a.name, questionId: q.id });
    this.say("Dismissed. It won't wait on an answer.", "ok");
    await this.refresh();
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
      // With a question open and no files, what you type answers it, as its card says.
      const q = !sent.length ? openQuestion(this.messages) : undefined;
      if (q) await this.c.call("answer", { name: a.name, questionId: q.id, text });
      else await this.c.call("send", sent.length ? { name: a.name, text, attachments: sent.map((p) => p.path) } : { name: a.name, text });
    } catch (e) {
      // Put it back, so nothing typed is ever lost to an error.
      this.input.setValue(text);
      this.pending = sent;
      throw e;
    }
    this.scroll = Number.MAX_SAFE_INTEGER;
    await this.refresh();
    // Delivered to the agent's inbox either way; say when it can't be answered yet, and why.
    const now = this.agents.find((x) => x.name === a.name);
    if (now?.offlineSince) this.say(`Sent. There's no internet right now: ${a.name} answers once it's back.`, "info");
    else if (now?.trouble) this.say(`Sent. ${a.name} can't reach ${now.trouble.backend} right now: it answers once it can.`, "info");
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

  /** What you can do with one MCP server, like Claude Code's /mcp: connect or disconnect it, check it again, see its tools, remove it. */
  private showMcpMenu(m: McpEntry, st?: { ok: boolean; tools: string[]; error?: string; needsSignIn?: boolean }): void {
    const a = this.needAgent();
    if (!a) return;
    const items: PickItem[] = [
      ...(st?.needsSignIn ? [{ label: "Sign in…", note: "in your browser", run: () => this.mcpSignIn(m.name) }] : []),
      m.enabled
        ? { label: `Disconnect from ${a.name}`, note: "from its next turn", run: () => this.setMcpEnabled(m.name, false) }
        : { label: `Connect to ${a.name}`, note: "from its next turn", run: () => this.setMcpEnabled(m.name, true) },
      ...(m.enabled ? [{ label: "Check again", note: "start it and list its tools", run: () => this.recheckMcp() }] : []),
      ...(st?.ok && st.tools.length ? [{ label: `See its ${st.tools.length} tools`, run: () => this.showMcpTools(m.name, st.tools) }] : []),
      ...(m.signedIn ? [{ label: "Sign out", note: "for every agent with this server", run: () => this.mcpSignOut(m.name) }] : []),
      { label: m.source === "shared" ? "Remove for all agents…" : `Remove from ${a.name}…`, run: () => this.confirmMcpRemove(m) },
    ];
    const title = `${m.name} · ${!m.enabled ? "off" : st?.ok ? "connected" : st?.needsSignIn ? "needs you to sign in" : st ? "failed" : "checking"}`;
    if (st && !st.ok && st.error && !st.needsSignIn) items.unshift({ label: st.error, info: true });
    this.show({ kind: "pick", title, items, idx: st && !st.ok && st.error && !st.needsSignIn ? 1 : 0, back: true });
  }

  /** Sign in to a server in the browser; the panel updates by itself once it's done. */
  private async mcpSignIn(server: string): Promise<void> {
    const a = this.needAgent();
    if (!a) return;
    const { authorizationUrl } = await this.c.call<{ authorizationUrl: string | null }>("mcpSignIn", { name: a.name, serverName: server }, 60_000);
    if (!authorizationUrl) {
      this.say(`Signed in to ${server}.`, "ok");
      return void (await this.showSettings());
    }
    this.show({
      kind: "pick",
      title: `Signing in to ${server}`,
      items: [
        { label: "Your browser opened the server's sign-in page. Finish there, and this updates by itself.", info: true },
        { label: "Open the page again", run: () => void this.opener(authorizationUrl) },
      ],
      idx: 1,
      back: true,
    });
    try {
      await this.c.call("mcpSignInWait", { name: a.name, serverName: server }, 11 * 60_000);
      this.say(`Signed in to ${server}. ${a.name} uses it from its next turn.`, "ok");
    } catch (e) {
      this.say(friendly(e), "err");
    }
    if (this.overlay?.kind === "pick" && this.overlay.title === `Signing in to ${server}`) await this.showSettings();
  }

  private async mcpSignOut(server: string): Promise<void> {
    const a = this.needAgent();
    if (!a) return;
    await this.c.call("mcpSignOut", { name: a.name, serverName: server });
    this.say(`Signed out of ${server}.`, "ok");
    await this.showSettings();
  }

  private showMcpTools(name: string, tools: string[]): void {
    this.show({ kind: "pick", title: `${name} · ${tools.length} tools`, items: tools.map((t) => ({ label: t, info: true })), idx: 0, back: true });
  }

  private async recheckMcp(): Promise<void> {
    const a = this.needAgent();
    if (!a) return;
    this.say("Checking its servers…", "info");
    await this.c.call("mcpStatus", { name: a.name, fresh: true }, 60_000).catch(() => {});
    await this.showSettings();
  }

  private async setMcpEnabled(name: string, enabled: boolean): Promise<void> {
    const a = this.needAgent();
    if (!a) return;
    await this.c.call("mcpSetEnabled", { name: a.name, serverName: name, enabled });
    this.say(`${name} ${enabled ? "connected to" : "disconnected from"} ${a.name}, from its next turn.`, "ok");
    await this.showSettings();
  }

  private confirmMcpRemove(m: McpEntry): void {
    const a = this.needAgent();
    if (!a) return;
    this.show({
      kind: "confirm",
      title: `Remove ${m.name}?`,
      body: [m.source === "shared" ? `Every agent loses ${m.name} from its next turn.` : `${a.name} loses ${m.name} from its next turn.`, "", muted(m.describe)],
      yes: "Remove",
      danger: true,
      focus: 1,
      run: async () => {
        await this.c.call("mcpRemove", { name: a.name, serverName: m.name });
        this.say(`Removed ${m.name}.`, "ok");
        await this.showSettings();
      },
    });
  }

  private async showSettings(): Promise<void> {
    if (!this.needAgent()) return;
    const o: SettingsOverlay = { kind: "settings", data: null, extra: null, idx: 0 };
    // On the first row you can act on, straight away: keys pressed while it loads are never undone.
    o.idx = this.settingsRows(o).findIndex((r) => !!(r.field || r.run));
    this.overlay = o;
    this.tui.requestRender();
    await this.loadSettings(o);
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
    try {
      o.mcp = await this.get<McpEntry[]>("mcpList", { name: a.name });
      // Status takes a moment (each server is started or reached), so it fills in when ready.
      void this.c
        .call<McpStatus>("mcpStatus", { name: a.name }, 60_000)
        .then((st) => {
          if (this.overlay === o) (o.mcpStatus = cleanDeep(st)), this.tui.requestRender();
        })
        .catch(() => {});
    } catch {
      o.mcp = undefined; // an older background process: the section just doesn't show
    }
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
      ...(o.mcp?.length
        ? [
            { label: "MCP servers", heading: true } as SettingsRow,
            ...o.mcp.map((m): SettingsRow => {
              const st = o.mcpStatus?.[m.name];
              const value = !m.enabled ? "○ off" : !o.mcpStatus ? "… checking" : st?.ok ? "✓ connected" : st?.needsSignIn ? "! sign in" : "✗ failed";
              const from = m.source === "shared" ? "all agents" : m.source === "person" ? "set by you" : `added by ${a.name}`;
              const detail = !m.enabled ? from : st?.ok ? `${st.tools.length} tool${st.tools.length === 1 ? "" : "s"} · ${from}` : st?.error ? `${st.error} · ${from}` : from;
              return { label: m.name, value, note: detail, stay: true, run: () => this.showMcpMenu(m, st) };
            }),
          ]
        : []),
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
      if (x.skills?.length) {
        rows.push({ label: "Skills", heading: true });
        for (const k of x.skills) rows.push({ label: k.name, note: `${k.source === "built-in" ? "" : `${k.source} · `}${k.description}`, stay: true, run: () => this.openLink(k.file) });
      }
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
    const composer = this.renderComposer(width, rows >= 16);
    const composerH = composer.length;
    const bodyH = Math.max(1, rows - TOP - chipsH - composerH - 1);
    const narrow = width < NARROW;
    const leftW = narrow ? 0 : Math.min(34, Math.max(26, Math.floor(width * 0.26)));
    const rightW = narrow ? width : width - leftW - 1;
    this.leftW = leftW;

    // The gap above the panes is padding only: the divider between them still runs to the top edge.
    const out: string[] = Array(TOP).fill(narrow ? "" : " ".repeat(leftW) + faint("│"));
    const left = narrow ? [] : this.renderAgents(leftW, bodyH);
    const right = this.renderRight(rightW, bodyH, narrow ? 0 : leftW + 1, narrow);
    for (let i = 0; i < bodyH; i++) {
      const r = right[i] ?? "";
      const lp = narrow ? "" : fit(left[i] ?? "", leftW) + faint("│");
      out.push(typeof r === "string" ? lp + fit(r, rightW) : lp + "    " + r.image);
    }
    if (chipsH) out.push(this.renderChips(width, TOP + bodyH));
    out.push(...composer);
    out.push(fit(this.renderFooter(width), width));
    return out;
  }

  /** The first row of the agent list: the name of the app, and what needs you across all agents. */
  private renderBrand(w: number): string {
    const title = ` ${accent("◆")} ${bold("overtime")}`;
    if (!this.connected) return spread(title, red("offline") + " ", w);
    if (this.agents[0]?.offlineSince) return spread(title, red("no internet") + " ", w);
    const working = this.agents.filter((a) => a.status === "working" || a.helpersRunning).length;
    const needs = this.agents.reduce((n, a) => n + a.waiting, 0);
    const right = needs ? yellow(`${needs} need${needs === 1 ? "s" : ""} you`) : working ? accent(`${working} working`) : "";
    return spread(title, right + " ", w);
  }

  private agentDetail(a: AgentSummary): string {
    const p = statusParts(a);
    if (p.word === "waiting") return p.detail;
    if (a.status === "working") return this.mainLive(a.name)?.step || a.activity || p.detail;
    // Waiting on its helpers: its own status line says what they're doing, if it set one.
    if (a.helpersRunning && a.status === "asleep") return a.ownStatus || p.detail;
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
      // Only the word "working" shines (enough to see it's busy at a glance); the rest stays quiet.
      const word = p.word === "working" ? shimmer(p.word) : muted(p.word);
      const l2 = bar + "   " + fit(`${p.color(p.dot)} ${word}${detail ? muted(` · ${cut(detail, Math.max(1, w - 9 - p.word.length))}`) : ""}`, w - 4);
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
    // Each thing once: line one is its state and, while working, the step it's on right now; line two
    // is its own status line. (The list on the left has the short version for scanning.)
    const own = a.status !== "new" ? a.ownStatus : "";
    const now = p.word === "working" ? this.mainLive(a.name)?.step ?? (a.helpersRunning ? `${a.helpersRunning} helper${a.helpersRunning === 1 ? "" : "s"}` : "") : own ? "" : p.detail;
    const state = `${p.color(`${p.dot} ${p.word}`)}${now ? muted(` · ${now}`) : p.word === "asleep" && p.detail ? muted(` · ${p.detail}`) : ""}`;
    const open = this.overlay?.kind === "settings";
    const btn = open ? inverse(" Settings ") : `${muted("⚙")} Settings ${muted("→")}`;
    const btnW = visibleWidth(btn) + 1;
    this.hits.push({ row: TOP, x0: x + w - btnW, x1: x + w, act: () => (open ? ((this.overlay = null), this.tui.requestRender()) : this.showSettings()) });
    const where = narrow && this.agents.length > 1 ? muted(`  ${this.sel + 1}/${this.agents.length} ↑↓`) : "";
    const lines = [spread(`  ${bold(a.name)}${where}  ${state}`, btn + " ", w)];
    const doing = own ? italic(muted(own)) : "";
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

    this.linkLine = -1;
    if (this.hasMore) body.push(muted("   ↑ older messages: ⇧↑ at the top loads them"), "");
    if (!this.messages.length) body.push("", muted(`   No messages with ${a.name} yet.`));

    for (const m of this.messages) {
      if (m.closes) continue; // a question's withdrawal or dismissal shows on the question itself
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
        const rec = recommendedOption(m.options, m.recommendation);
        if (!open && m.answer) {
          // Answered: folded to the question and what you chose, so it never looks like it's still open.
          for (const l of paras(`${muted("?")} ${muted(hq.title)}  ${muted(stamp(m.t))}`, inner - 4)) body.push(line(l));
          const chosen = m.answer.choice && m.options?.[m.answer.choice - 1];
          const said = m.answer.note ?? m.answer.text ?? "";
          if (m.answer.closed) body.push(line(muted(m.answer.closed === "dismissed" ? "✕ You dismissed this question" : `✕ ${a.name} withdrew this question`)));
          else body.push(line(`${accent("✓")} ${chosen ? `You chose ${bold(optionLabel(chosen))}` : `You answered: ${said}`}`));
          if (!m.answer.closed && chosen && m.answer.note) for (const l of paras(muted(m.answer.note), inner - 4)) body.push(line(l));
          t = this.pushExtras(m, body, bodyHits, w, t, line);
          body.push("");
          prev = m;
          continue;
        }
        for (const l of paras(`${open ? yellow(bold("?")) : muted("?")} ${open ? bold(hq.title) : muted(hq.title)}  ${muted(stamp(m.t))}`, inner - 4)) body.push(line(l));
        if (hq.body) for (const l of markdownLines(hq.body, inner - 4)) body.push(line(linkify(l, m.links)));
        if (m.why) for (const l of paras(muted(m.why), inner - 4)) body.push(line(l));
        // A recommendation that names an option is marked on it; anything else gets its own line.
        if (m.recommendation && rec < 0) for (const l of paras(`${bold("I'd suggest:")} ${m.recommendation}`, inner - 4)) body.push(line(l));
        if (m.options?.length) {
          body.push(line(""));
          m.options.forEach((o, i) => {
            const n = i + 1;
            const picked = open && this.choosing?.id === m.id && this.choosing.n === n;
            const label = optionLabel(o);
            const tag = i === rec ? muted("  · suggested") : "";
            if (open) {
              bodyHits.push({ line: body.length, act: () => ((this.choosing = null), this.answer(m, n)) });
              const num = picked ? inverse(bold(yellow(` ${n} `))) : inverse(accent(` ${n} `));
              body.push(line(`${num} ${picked ? bold(label) : label}${tag}${picked ? `  ${yellow("← Enter to answer, Esc to cancel")}` : ""}`));
            } else body.push(line(muted(`${n}  ${label}`)));
          });
        }
        if (open) {
          const picked = this.choosing?.id === m.id && this.choosing.n === 0;
          bodyHits.push({ line: body.length, act: () => ((this.choosing = null), this.dismiss(m)) });
          body.push(line(`${picked ? inverse(bold(yellow(" 0 "))) : muted(" 0 ")} ${picked ? bold("Dismiss this question") : muted("Dismiss this question")}${picked ? `  ${yellow("← Enter to dismiss, Esc to cancel")}` : ""}`));
        }
        if (open) {
          body.push(line(""));
          for (const l of paras(muted(m.options?.length ? `Press ${m.options.length === 1 ? "1" : `1–${m.options.length}`} to choose (0 to dismiss), then Enter. Or type a message to answer in your own words.` : "Type a message to answer, or press 0 then Enter to dismiss."), inner - 4)) body.push(line(l));
        }
        t = this.pushExtras(m, body, bodyHits, w, t, line);
        body.push("");
      } else if (m.kind === "alert") {
        const line = (s: string) => `  ${red("┃")} ${s}`;
        if (body.length && body.at(-1) !== "") body.push("");
        const ha = headed(m, "Something went wrong");
        body.push(line(`${red(bold(ha.title))}  ${muted(stamp(m.t))}${m.from === "overtime" ? muted("  · from Overtime") : ""}`));
        if (ha.body) for (const l of markdownLines(ha.body, inner - 4)) body.push(line(linkify(l, m.links)));
        t = this.pushExtras(m, body, bodyHits, w, t, line);
        body.push("");
      } else {
        // The agent's words, and Overtime's notes: plain text, the name only when the speaker changes.
        // A blank line before every message, so separate messages never read as one; the name and time
        // only when the speaker changes (or after a pause).
        if (body.length && body.at(-1) !== "") body.push("");
        if (regroup) body.push(`  ${m.from === "agent" ? accent(bold(a.name)) : muted(bold("Overtime"))}  ${muted(stamp(m.t))}`);
        // A faint bar down the side of each message, unbroken across its own blank lines, so where one
        // message ends and the next begins is always visible.
        const ind = (s: string) => "  " + faint("│") + " " + s;
        if (m.kind === "report" && m.title) body.push(ind(`${accent("▣")} ${bold(m.title)}`));
        const text = m.kind === "report" && m.title && m.text.startsWith(m.title) ? m.text.slice(m.title.length).trim() : m.text;
        // The agent's words as Markdown (bold, italics, lists, quotes, code, tables); Overtime's notes plain.
        if (text) {
          const lines = m.from === "overtime" ? paras(linkify(muted(text), m.links)) : markdownLines(text, inner).map((l) => linkify(l, m.links));
          for (const l of lines) body.push(ind(l));
        }
        t = this.pushExtras(m, body, bodyHits, w, t, ind);
      }
      prev = m;
    }

    // While the agent works on what you just said, show that it's on it (and what it's doing right now).
    const live = this.chatLive(a.name) ?? this.mainLive(a.name);
    const waitingOnIt = [...this.messages].reverse().find((m) => !m.closes)?.from === "you";
    if (live && waitingOnIt) {
      if (body.length && body.at(-1) !== "") body.push("");
      body.push(`  ${accent(bold(a.name))}  ${muted(`${spinner()} ${live.step ?? "thinking…"}`)}`);
    }
    body.push("");

    const maxScroll = Math.max(0, body.length - h);
    this.lastMax = maxScroll;
    let s: number;
    // A link picked with Ctrl+L that's out of view: scroll to it.
    if (this.linkIdx >= 0 && this.linkLine >= 0) {
      const cur = this.scroll === Number.MAX_SAFE_INTEGER ? maxScroll : Math.min(this.scroll, maxScroll);
      if (this.linkLine < cur || this.linkLine >= cur + h) {
        const to = Math.min(maxScroll, Math.max(0, this.linkLine - Math.floor(h / 2)));
        this.scroll = to >= maxScroll ? Number.MAX_SAFE_INTEGER : to;
        this.anchor = null;
      }
    }
    if (this.scroll !== Number.MAX_SAFE_INTEGER) s = Math.min(this.scroll, maxScroll);
    else if (live) s = maxScroll;
    else if (this.anchor) {
      // A one-time jump: the open question from its top, or a long new message from its start.
      const target = this.anchor === "question" && questionStart >= 0 ? questionStart - 1 : body.length - lastStart > h ? lastStart - 1 : maxScroll;
      s = Math.min(maxScroll, Math.max(0, target));
      this.anchor = null;
      if (s < maxScroll) this.scroll = s; // from here on, your scrolling decides
    } else s = maxScroll;
    this.lastTop = s;
    const view = body.slice(s, s + h);
    // Images only when all their rows are in view; otherwise just their file line shows.
    for (let i = 0; i < view.length; i++) {
      const v = view[i];
      if (typeof v !== "string" && i + v.rows > view.length) view[i] = "";
    }
    if (s > 0 && view.length > 1 && typeof view[0] === "string") view[0] = muted(`   ↑ ${s} line${s === 1 ? "" : "s"} above · ⇧↑`);
    if (s < maxScroll && view.length === h && h > 1) view[h - 1] = muted(`   ↓ newer below · ⇧↓`);
    for (const bh of bodyHits) {
      const row = bh.line - s;
      if (row >= 0 && row < h) this.hits.push({ row: top + row, x0: x, x1: x + w, act: bh.act });
    }
    return view;
  }

  /** A message's links, then its files (with an inline preview for images where the terminal can show one). */
  private pushExtras(m: Message, body: Line[], hits: { line: number; act: () => void }[], w: number, t: number, wrapLine: (s: string) => string): number {
    // Links are clickable where they're written, and also listed under the message, paths and web
    // links alike, so they're easy to find and open.
    if (m.links?.length) body.push(wrapLine(""));
    for (const l of m.links ?? []) {
      const idx = t++;
      const url = l.kind === "url" ? l.target : pathToFileURL(l.target).href;
      const label = l.kind === "url" ? l.label : tilde(l.label);
      const target = l.target;
      hits.push({ line: body.length, act: () => this.openLink(target) });
      if (idx === this.linkIdx) this.linkLine = body.length;
      // The picked one keeps "Enter opens" in view by shortening a long path rather than the hint.
      body.push(wrapLine(idx === this.linkIdx ? inverse(` ↗ ${cut(label, Math.max(10, w - 26))} `) + muted("  Enter opens") : accent(`↗ ${link(url, underline(label))}`)));
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
      else if (r.run && r.value !== undefined) line = label + fit(on ? accent(r.value) : r.value, valueW - 2) + (notes ? "  " + muted(r.note ?? "") : "");
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
        ...row("⇧↑ ⇧↓", "scroll the messages (Option+↑↓, PgUp PgDn and the mouse wheel work too)"),
        "",
        muted("MESSAGES"),
        ...row("type, Enter", "write a message and send it"),
        ...row("⌥/⇧ Enter", "a new line in the message (Ctrl+J works too); pasted text keeps its lines"),
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
    if (q?.options?.length) return this.choosing ? "Enter answers with the option you picked; Esc cancels" : `Press ${q.options.length === 1 ? "1" : `1–${q.options.length}`} to choose, or type a message`;
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

  private renderComposer(w: number, roomy: boolean): string[] {
    const active = !this.overlay;
    this.input.focused = active;
    if (active) this.fieldInput.focused = false;
    const inner = Math.max(4, w - 8);
    // Empty (or a panel is open): the placeholder, with the cursor at its start when typing is possible.
    const empty = !this.input.getText();
    const typed = empty || !active ? null : this.input.body(inner);
    const body = typed ? typed.text : [active ? `\x1b[7m \x1b[0m${muted(fit(this.placeholder(), inner - 1))}` : muted(fit(this.placeholder(), inner))];
    const prompt = active ? accent("›") : muted("›");
    // The / menu sits under what you're typing, inside the box.
    const lines = [...body.map((l, n) => `${n === 0 ? prompt : " "} ${l}`), ...(typed?.menu.length ? ["", ...typed.menu.map((l) => `  ${l}`)] : [])];
    if (!roomy) return lines.map((l) => fit(" " + l, w));
    // Like Grok CLI: a filled block on a tint, no border. Without tints, a quiet rounded border.
    if (hasTints()) return [element("", w), ...lines.map((l) => element(`  ${l}`, w)), element("", w)];
    const c = active && this.typing() ? accent : faint;
    return [c("╭" + "─".repeat(Math.max(0, w - 2)) + "╮"), ...lines.map((l) => c("│") + " " + fit(l, w - 4) + " " + c("│")), c("╰" + "─".repeat(Math.max(0, w - 2)) + "╯")];
  }

  private renderFooter(w: number): string {
    if (!this.connected && !this.flash) return ` ${red("✗")} ${red("Can't reach the background process. Reconnecting…")}`;
    const offline = this.agents[0]?.offlineSince;
    if (offline && !this.flash) return ` ${red("✗")} ${red(`No internet connection since ${stamp(offline)}.`)} ${muted("Your agents wait, and carry on by themselves once it's back.")}`;
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
    else if (this.typing() || this.pending.length) hints = [keyHint("enter", "send"), keyHint("⌥/⇧ enter", "new line"), keyHint("esc", "clear")];
    else if (this.choosing) hints = [keyHint("enter", "answer"), keyHint("1–9", "change"), keyHint("esc", "cancel")];
    else hints = [q?.options?.length ? keyHint(`1–${q.options.length}`, "choose") : "", keyHint("↑↓", "agents"), keyHint("→", "settings"), keyHint("⇧↑↓", "scroll"), this.targets().length ? keyHint("^L", "links") : "", keyHint("?", "keys")].filter(Boolean);
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
  const tui = new TuiAltScreen(term, false, undefined, { openUrl: (url) => app.openLink(url), copyOnSelect: true, copySelection: (text) => copyText(text, (seq) => term.write(seq)), mouse: o.mouse ?? !o.terminal });
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
  timers.push(setInterval(() => (app.live.size || app.agents.some((a) => a.status === "working" || a.helpersRunning)) && tui.requestRender(), 80));
  timers.push(setInterval(() => void app.refresh(), 15_000));
  return { app, tui, stop: () => app.quit() };
}
