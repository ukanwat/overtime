import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Editor,
  Markdown,
  decodeKittyPrintable,
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
  stripTerminalSequences,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Terminal,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  type AutocompleteItem,
  type AutocompleteProvider,
  type KeyId,
  type Keybinding,
  fuzzyFilter,
} from "@earendil-works/pi-tui";
import { ensureDaemon, isDaemonGone, type DaemonClient } from "../daemon/client.js";
import type { AgentSummary } from "../daemon/control.js";
import { validateName } from "../agent/agent.js";
import { paths } from "../paths.js";
import { pastedFiles, type PendingAttachment } from "./attach.js";
import { copyText } from "./clipboard.js";
import { wholeSequences } from "./input.js";
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
  cut,
  italic,
  link,
  money,
  muted,
  openTarget,
  panel,
  red,
  picked,
  selected,
  spread,
  SPINNER,
  stamp,
  stateGlyph,
  stateWord,
  statusParts,
  underline,
  when,
  yellow,
} from "./style.js";
import { closedLine, headed, humanBytes, openQuestions, optionLabel, questionParts, replyTo, recommendedOption, shortQuestion, type AgentSettingsView, type LiveState, type Message } from "./types.js";

export { clean, cleanDeep, openPlan } from "./style.js";
export type { LiveState, Message } from "./types.js";

// ---------- layout ----------

// On the same 100 ms beat as the agents' state glyphs, so the frame timer never lands between two frames.
const spinner = () => SPINNER[Math.floor(Date.now() / 100) % SPINNER.length];
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
  /** What the row is, when its label can change or be another row's (Stop/Start, a server's name). */
  key?: string;
}

/** A settings row's identity, kept across refreshes. */
const rowKey = (r: SettingsRow) => r.key ?? r.field ?? r.label;

type McpEntry = { name: string; source: "shared" | "person" | "agent"; enabled: boolean; describe: string; signedIn?: boolean };
type McpStatus = Record<string, { ok: boolean; tools: string[]; error?: string; needsSignIn?: boolean }>;
/**
 * The settings step of "+ New agent", before anything is made: only what the person changed, over
 * the defaults it starts from (and which backends can run here, to say so before it's created).
 */
type NewAgentDraft = {
  name: string;
  patch: { backend?: string; model?: string | null; dailyBudgetUsd?: number; workspace?: string | null; visibility?: "public" | "private" };
  defaults?: { backend: string; model: string | null; dailyBudgetUsd: number };
  status?: { name: string; missing: string | null }[];
  ready?: Promise<void>;
};
type SettingsOverlay = { kind: "settings"; data: AgentSettingsView | null; extra: any; mcp?: McpEntry[]; mcpStatus?: McpStatus; global?: { autoUpdate: boolean; version: string }; idx: number; sel?: string; editing?: Field; error?: string; draft?: NewAgentDraft };
type Overlay =
  | null
  | { kind: "help" }
  | SettingsOverlay
  | { kind: "pick"; title: string; items: PickItem[]; idx: number; loading?: string; back?: boolean | SettingsOverlay }
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


/** A place in the message box's text: a line, and a position in it (as the editor counts, UTF-16 units). */
export interface Pos {
  line: number;
  col: number;
}

const isBefore = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.col < b.col);

/**
 * Keys that select as they move, and the move each makes. Terminals send Shift+Option+← in several
 * ways: xterm's modifier code, ESC before Shift+← (macOS Terminal with "Use Option as Meta key"), or
 * Shift+Ctrl+← in others. Cmd+Shift+← only arrives from terminals that report Cmd (kitty's protocol).
 */
const SELECT_MOVES: { keys: KeyId[]; raw?: string[]; move: "left" | "right" | "up" | "down" | "wordLeft" | "wordRight" | "lineStart" | "lineEnd" }[] = [
  { keys: ["shift+left"], move: "left" },
  { keys: ["shift+right"], move: "right" },
  { keys: ["shift+up"], move: "up" },
  { keys: ["shift+down"], move: "down" },
  { keys: ["shift+alt+left", "shift+ctrl+left"], raw: ["\x1b\x1b[1;2D"], move: "wordLeft" },
  { keys: ["shift+alt+right", "shift+ctrl+right"], raw: ["\x1b\x1b[1;2C"], move: "wordRight" },
  { keys: ["shift+home", "shift+super+left"], move: "lineStart" },
  { keys: ["shift+end", "shift+super+right"], move: "lineEnd" },
];

/** Keys that delete: with text selected, each deletes just the selection. */
const DELETES: Keybinding[] = ["tui.editor.deleteCharBackward", "tui.editor.deleteCharForward", "tui.editor.deleteWordBackward", "tui.editor.deleteWordForward", "tui.editor.deleteToLineStart", "tui.editor.deleteToLineEnd"];

/**
 * The message box: a multi-line editor. Enter sends; Shift+Enter or Ctrl+J starts a new line; a pasted
 * block keeps its line breaks (a long one shows as a "[paste #1 +40 lines]" marker and is sent in full).
 * It draws no border of its own: the app frames it.
 *
 * Text in it can be selected like in any text box (the editor itself has only a cursor): Shift with the
 * arrows, the mouse, or Ctrl+A twice. What's selected is the text between `anchor` and the cursor;
 * typing or pasting replaces it and the delete keys delete it.
 */
class Composer extends Editor {
  /** Lines scrolled out of the box above and below, as last drawn (the editor shows them on its borders). */
  above = 0;
  below = 0;
  /** Where the selection started; the cursor is its other end. Null: nothing is selected. */
  anchor: Pos | null = null;
  /** The key before this one, so a second Ctrl+A in a row can select everything. */
  private lastKey = "";

  /** The editor's own state and helpers, which it keeps private. */
  private get ed(): any {
    return this;
  }
  private get lines(): string[] {
    return this.ed.state.lines;
  }

  cursorPos(): Pos {
    const c = this.getCursor();
    return { line: c.line, col: c.col };
  }

  private setCursor(p: Pos): void {
    this.ed.state.cursorLine = p.line;
    this.ed.setCursorCol(p.col);
    this.ed.lastAction = null;
  }

  /** The selected range, start first; null when nothing (or nothing but an empty range) is selected. */
  selection(): { start: Pos; end: Pos } | null {
    const a = this.anchor;
    if (!a || a.line >= this.lines.length) return null;
    const anchor = { line: a.line, col: Math.min(a.col, this.lines[a.line].length) };
    const cursor = this.cursorPos();
    if (anchor.line === cursor.line && anchor.col === cursor.col) return null;
    return isBefore(anchor, cursor) ? { start: anchor, end: cursor } : { start: cursor, end: anchor };
  }

  /** The selected text, with pasted blocks in full ("" when nothing is selected). */
  selectedText(): string {
    const s = this.selection();
    if (!s) return "";
    const text = this.lines
      .slice(s.start.line, s.end.line + 1)
      .map((l, i, all) => l.slice(i === 0 ? s.start.col : 0, i === all.length - 1 ? s.end.col : undefined))
      .join("\n");
    return this.ed.expandPasteMarkers(text);
  }

  /** Select from one place to another (the cursor goes to `to`). */
  select(from: Pos, to: Pos): void {
    this.setCursor(to);
    this.anchor = from.line === to.line && from.col === to.col ? null : from;
  }

  selectAll(): void {
    const last = this.lines.length - 1;
    this.select({ line: 0, col: 0 }, { line: last, col: this.lines[last].length });
  }

  deselect(): void {
    this.anchor = null;
  }

  /** Delete the selected text (undoably); false when nothing was selected. */
  deleteSelection(): boolean {
    const s = this.selection();
    this.anchor = null;
    if (!s) return false;
    this.ed.exitHistoryBrowsing();
    this.ed.pushUndoSnapshot();
    const lines = this.lines;
    lines.splice(s.start.line, s.end.line - s.start.line + 1, lines[s.start.line].slice(0, s.start.col) + lines[s.end.line].slice(s.end.col));
    this.setCursor(s.start);
    this.onChange?.(this.getText());
    return true;
  }

  /**
   * The place under a point of the box: `row` counts the text's rows from the first one in view (above
   * or below the box reaches the rows out of view, so dragging past an edge scrolls), `x` is the column
   * from the text's left edge. Past the end of a row is the end of it.
   */
  posAt(row: number, x: number): Pos {
    const rows: { logicalLine: number; startCol: number; length: number }[] = this.ed.buildVisualLineMap(this.ed.lastWidth);
    const i = this.ed.scrollOffset + row;
    if (!rows.length || i < 0) return { line: 0, col: 0 };
    if (i >= rows.length) {
      const last = this.lines.length - 1;
      return { line: last, col: this.lines[last].length };
    }
    const r = rows[i];
    const chunk = this.lines[r.logicalLine].slice(r.startCol, r.startCol + r.length);
    let col = 0;
    let at = chunk.length;
    for (const g of this.ed.segment(chunk, "grapheme")) {
      const next = col + visibleWidth(g.segment);
      if (x < next) {
        at = g.index;
        break;
      }
      col = next;
    }
    // A row that wraps onto the next one ends where the next starts: past its end is its last character.
    const wraps = rows[i + 1]?.logicalLine === r.logicalLine;
    if (wraps && at === chunk.length && chunk.length) at = [...this.ed.segment(chunk, "grapheme")].pop().index;
    return { line: r.logicalLine, col: r.startCol + at };
  }

  /** The place one character on from p, on its line (p itself at the line's end). */
  after(p: Pos): Pos {
    const line = this.lines[p.line] ?? "";
    for (const g of this.ed.segment(line, "grapheme")) if (g.index >= p.col) return { line: p.line, col: g.index + g.segment.length };
    return { line: p.line, col: line.length };
  }

  /**
   * The word at p, like a double-click in the conversation picks it: paths and dashed-words stay whole.
   * Between words, the space or mark there.
   */
  wordAt(p: Pos): { start: Pos; end: Pos } {
    const line = this.lines[p.line] ?? "";
    const segs: { start: number; end: number; word: boolean; joiner: boolean }[] = [];
    for (const s of this.ed.segment(line, "word")) {
      const joiner = s.segment === "/" || s.segment === "-";
      segs.push({ start: s.index, end: s.index + s.segment.length, word: s.isWordLike !== false || joiner, joiner });
    }
    let i = segs.findIndex((s) => p.col >= s.start && p.col < s.end);
    if (i < 0) i = segs.length - 1;
    if (i < 0) return { start: p, end: p };
    const join = (a: (typeof segs)[number], b: (typeof segs)[number]) => a.word && b.word && (a.joiner || b.joiner);
    let a = i;
    let b = i;
    while (a > 0 && join(segs[a - 1], segs[a])) a--;
    while (b < segs.length - 1 && join(segs[b], segs[b + 1])) b++;
    return { start: { line: p.line, col: segs[a].start }, end: { line: p.line, col: segs[b].end } };
  }

  setText(text: string): void {
    this.anchor = null;
    super.setText(text);
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    const last = this.lastKey;
    this.lastKey = data;
    const sel = SELECT_MOVES.find((m) => m.raw?.includes(data) || m.keys.some((k) => matchesKey(data, k)));
    if (sel) {
      const from = this.anchor ?? this.cursorPos();
      this.moveCursorBy(sel.move);
      const to = this.cursorPos();
      this.anchor = from.line === to.line && from.col === to.col ? null : from;
      return;
    }
    // Ctrl+A goes to the start of the line, as in a shell; pressed again straight away, it selects everything.
    if (matchesKey(data, "ctrl+a") && last === data) return this.selectAll();
    if (matchesKey(data, "super+a")) return this.selectAll();
    const s = this.selection();
    if (!s) {
      this.anchor = null;
      return super.handleInput(data);
    }
    if (DELETES.some((id) => kb.matches(data, id)) || matchesKey(data, "shift+backspace") || matchesKey(data, "shift+delete")) {
      this.deleteSelection();
      return;
    }
    // ← and → close the selection at its start or end, like a text box does.
    if (kb.matches(data, "tui.editor.cursorLeft") || kb.matches(data, "tui.editor.cursorRight")) {
      this.anchor = null;
      this.setCursor(kb.matches(data, "tui.editor.cursorLeft") ? s.start : s.end);
      return;
    }
    // Typing, pasting or a new line replaces what's selected. Undo brings it back in one step.
    const typed = data.includes("\x1b[200~") || data === "\n" || decodeKittyPrintable(data) !== undefined || (data.charCodeAt(0) >= 32 && !data.startsWith("\x1b") && data !== "\x7f");
    if (!typed) {
      this.anchor = null;
      return super.handleInput(data);
    }
    this.deleteSelection();
    const undo = this.ed.undoStack;
    const steps = undo.length;
    super.handleInput(data);
    while (undo.length > steps) undo.pop();
  }

  private moveCursorBy(move: (typeof SELECT_MOVES)[number]["move"]): void {
    const ed = this.ed;
    if (move === "left") ed.moveCursor(0, -1);
    else if (move === "right") ed.moveCursor(0, 1);
    // Up on the first row and down on the last go to the start and end, as in a text box.
    else if (move === "up") ed.isOnFirstVisualLine() ? this.setCursor({ line: 0, col: 0 }) : ed.moveCursor(-1, 0);
    else if (move === "down") ed.isOnLastVisualLine() ? this.setCursor({ line: this.lines.length - 1, col: this.lines[this.lines.length - 1].length }) : ed.moveCursor(1, 0);
    else if (move === "wordLeft") ed.moveWordBackwards();
    else if (move === "wordRight") ed.moveWordForwards();
    else if (move === "lineStart") ed.moveToLineStart();
    else ed.moveToLineEnd();
  }

  /** The editor's rows, with what's selected shown inverted (and no cursor while anything is, as in a text box). */
  render(width: number): string[] {
    const out = super.render(width);
    const s = this.selection();
    if (!s) return out;
    const ed = this.ed;
    const rows: { logicalLine: number; startCol: number; length: number }[] = ed.buildVisualLineMap(ed.lastWidth);
    for (let i = 0; i < ed.renderedVisibleLineCount; i++) {
      const r = rows[ed.scrollOffset + i];
      if (!r) continue;
      const text = this.lines[r.logicalLine].slice(r.startCol, r.startCol + r.length);
      const L = r.logicalLine;
      const inside = L >= s.start.line && L <= s.end.line;
      const from = !inside ? 0 : L === s.start.line ? Math.max(0, Math.min(text.length, s.start.col - r.startCol)) : 0;
      const to = !inside ? 0 : L === s.end.line ? Math.max(0, Math.min(text.length, s.end.col - r.startCol)) : text.length;
      // A line break that's selected shows as one selected space at the end of its line.
      const lastRow = rows[ed.scrollOffset + i + 1]?.logicalLine !== L;
      const nl = inside && L < s.end.line && lastRow ? "\x1b[7m \x1b[27m" : "";
      const line = from < to ? text.slice(0, from) + "\x1b[7m" + text.slice(from, to) + "\x1b[27m" + text.slice(to) + nl : text + nl;
      out[1 + i] = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
    }
    return out;
  }
  protected renderTopBorder(_width: number, hidden: number): string {
    this.above = hidden;
    return "";
  }
  protected renderBottomBorder(_width: number, hidden: number): string {
    this.below = hidden;
    return "";
  }
  /** The full text, with pasted blocks expanded. */
  getValue(): string {
    return this.getExpandedText();
  }
  setValue(v: string): void {
    this.setText(v);
  }
  /** Its text lines at this width, cursor included, without the (empty) borders, the open menu's lines, and how many lines are out of view. */
  body(width: number): { text: string[]; menu: string[]; above: number; below: number } {
    const lines = this.render(width);
    const menu = (this as any).renderedAutocompleteHeight ?? 0;
    return { text: lines.slice(1, Math.max(2, lines.length - 1 - menu)), menu: menu ? lines.slice(lines.length - menu) : [], above: this.above, below: this.below };
  }

  /** The / menu's list (the editor keeps it private); null when the menu is closed. */
  private get menuList(): { selectedIndex: number; filteredItems: unknown[]; getVisibleRange(): { startIndex: number; endIndex: number } } | null {
    return this.isShowingAutocomplete() ? (this.ed.autocompleteList ?? null) : null;
  }

  /** Which of the / menu's items are in view, as indexes (none when it's closed). */
  menuShown(): { start: number; end: number } {
    const r = this.menuList?.getVisibleRange();
    return r ? { start: r.startIndex, end: r.endIndex } : { start: 0, end: 0 };
  }

  /** Move the / menu's highlight by d items, stopping at either end (as its own wheel does). */
  moveMenu(d: number): void {
    const list = this.menuList;
    if (list) list.selectedIndex = Math.max(0, Math.min(list.filteredItems.length - 1, list.selectedIndex + d));
  }

  /** Highlight item i of the / menu and choose it, exactly as Enter on it does. */
  pickMenu(i: number): void {
    const list = this.menuList;
    if (!list || i < 0 || i >= list.filteredItems.length) return;
    list.selectedIndex = i;
    this.handleInput("\r");
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
  /**
   * The selected agent's open questions, oldest first: every one, however far back it was asked. They're
   * pinned together above the message box, so they never scroll away and nothing replaces another.
   */
  open: Message[] = [];
  /**
   * The open question you've gone to (Tab, a click), or null: the message box is yours, and what you type
   * there is a message, never an answer. While a question has focus, the box takes your answer to it.
   */
  asking: string | null = null;
  /**
   * Your answer to each open question as you make it, waiting for Enter (so one stray key never answers): the
   * options picked for each of its questions, your own words for any, which question you're on (a card can
   * hold several), or 0 pressed to dismiss it. Kept while you go back to your message or to another question.
   */
  private answers = new Map<string, { id: string; at: number; picks: number[][]; notes: (string | undefined)[]; dismiss: boolean }>();
  /** The message you were writing when you went to the questions, given back when you leave them. */
  private held: string | null = null;
  fieldInput = new Input({ prompt: "", placeholderStyle: muted });
  pending: PendingAttachment[] = [];
  /** What you'd started writing (and attaching) to each agent, kept while you look at another one. */
  private drafts = new Map<string | null, { text: string; pending: PendingAttachment[] }>();
  connected = true;
  live = new Map<string, LiveState>();
  private hits: Hit[] = [];
  /** Screen rows the two panes take (from the top edge down to the message box), as last drawn. */
  private paneRows = 0;
  /** The agent list's rows: down to the footer, beside the conversation and the message box. */
  private listRows = 0;
  /**
   * Where the message box was drawn: its screen rows, and its text's first row, row count and left
   * column. A mouse press there is the box's (it places the cursor and selects text in it), never the
   * screen's, so a selection there can't run into the conversation or pick up the box's frame.
   */
  private box = { top: 0, bottom: -1, left: 0, textTop: 0, textRows: 0, textX: 0, textW: 0, menuRows: 0 };
  /** A mouse press in the message box being dragged: where it was pressed. */
  private boxPress: Pos | null = null;
  private width = 0;
  /** Per screen row of the right pane, the columns its text is in: past a message's bar, inside a panel's frame. */
  private textCols = new Map<number, [number, number]>();
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
  private anchor: "last" | null = "last";
  private lastTop = 0;
  private loadingOlder: Promise<void> | null = null;
  /** The line each message started on, as last drawn. */
  private msgLine = new Map<string, number>();
  /** After older messages are added above: the message that was on screen, so the view stays on it. */
  private keep: { id: string; line: number; top: number } | null = null;
  /** Lines scrolled up past the top while older messages load, applied once they're in. */
  private pendingUp = 0;
  private leftW = 0;
  /** How soon (ms) something drawn in the last frame changes by itself: a state glyph. Infinity if nothing does. */
  private motion = Infinity;
  private loadedFor = "";
  private started = false;
  /** The selected agent's name (null: the "+ New agent" row). */
  private selName: string | null = null;
  private images = new Map<string, { b64: string; w: number; h: number } | null>();

  /** Put text on the system clipboard (tests replace this); true if it got there. */
  clipboard: (text: string) => Promise<boolean> | boolean = (text) => copyText(text, (seq) => this.term.write(seq));

  constructor(public c: DaemonClient, private readonly tui: TuiAltScreen, private readonly term: Terminal, private readonly onQuit: () => void, private readonly opener: (t: string) => string | void = openTarget) {
    this.input = new Composer(tui as any, {
      borderColor: (x: string) => x,
      selectList: { selectedPrefix: accent, selectedText: (t: string) => bold(t), description: muted, scrollInfo: muted, noMatch: muted },
    });
    // Enter is the app's to handle (send), never the editor's own submit.
    this.input.disableSubmit = true;
    // The selected agent's skills; on "+ New agent" the box takes a name, and the last agent's skills aren't its.
    this.input.setAutocompleteProvider(new SkillCompletion(() => (this.onNewRow ? [] : this.skills)));
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
        const r = await this.get<{ messages: Message[]; hasMore: boolean; open?: Message[] }>("messages", { name: a.name, markRead: true, limit: 300 });
        if (this.agent?.name !== a.name) return;
        let fresh = r?.messages ?? [];
        let more = !!r?.hasMore;
        // More than a page came since, while you're reading further up: fetch the ones in between too, so
        // what you're reading (and the older messages you loaded) stays, with nothing missing below it.
        const have = new Set(this.loadedFor === a.name && this.scroll !== Number.MAX_SAFE_INTEGER ? this.messages.map((m) => m.id) : []);
        for (let page = 0; page < 10 && have.size && more && fresh.length && !fresh.some((m) => have.has(m.id)); page++) {
          const gap = await this.get<{ messages: Message[]; hasMore: boolean }>("messages", { name: a.name, before: fresh[0].id, limit: 300 });
          if (this.agent?.name !== a.name) return;
          fresh = [...(gap?.messages ?? []), ...fresh];
          more = !!gap?.hasMore;
        }
        if (this.loadedFor !== a.name) {
          this.scroll = Number.MAX_SAFE_INTEGER;
          this.anchor = "last";
        } else if (this.scroll === Number.MAX_SAFE_INTEGER && fresh.at(-1)?.id !== this.messages.at(-1)?.id) {
          // Something new while you're at the bottom: show it (from its start if it's long), once.
          this.anchor = "last";
        }
        this.open = r?.open ?? openQuestions(fresh);
        // A question answered or withdrawn meanwhile (here, in the CLI, by the agent) lets go of its focus and draft.
        for (const id of this.answers.keys()) if (!this.open.some((q) => q.id === id)) this.answers.delete(id);
        if (this.asking && !this.open.some((q) => q.id === this.asking)) this.leaveQuestions(false);
        // Older messages you loaded stay: a refresh only brings the latest ones, and dropping the rest
        // would pull the conversation out from under where you're reading.
        const k = this.loadedFor === a.name && fresh.length ? this.messages.findIndex((m) => m.id === fresh[0].id) : -1;
        if (k > 0) this.messages = [...this.messages.slice(0, k), ...fresh];
        else {
          this.messages = fresh;
          this.hasMore = more;
        }
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
        this.open = [];
        this.loadedFor = "";
        // A new agent's settings step stays open: things happening elsewhere mustn't close it.
        if (this.overlay?.kind === "settings" && !this.overlay.draft) this.overlay = null;
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

  /** Older messages, when scrolled to the top. One load at a time: the wheel asks many times a second. */
  private loadOlder(): Promise<void> {
    this.loadingOlder ??= this.doLoadOlder().finally(() => {
      this.loadingOlder = null;
      // Nothing older came: there's nowhere to take the steps made meanwhile.
      if (!this.keep) this.pendingUp = 0;
    });
    return this.loadingOlder;
  }

  private async doLoadOlder(): Promise<void> {
    const a = this.agent;
    const first = this.messages[0];
    if (!a || this.onNewRow || !this.hasMore || !first) return;
    const r = await this.get<{ messages: Message[]; hasMore: boolean }>("messages", { name: a.name, before: first.id, limit: 300 });
    if (this.agent?.name !== a.name || this.messages[0]?.id !== first.id) return;
    // What you were reading stays where it was on screen, with the older messages above it.
    const ref = this.messages.find((m) => this.msgLine.has(m.id));
    if (ref) this.keep = { id: ref.id, line: this.msgLine.get(ref.id)!, top: this.lastTop };
    const seen = new Set(this.messages.map((m) => m.id));
    this.messages = [...(r?.messages ?? []).filter((m) => !seen.has(m.id)), ...this.messages];
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

  say(text: string, tone: "ok" | "err" | "info" = "info", ms = tone === "err" ? 8000 : 4000): void {
    this.flash = { text, tone };
    this.tui.requestRender();
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flash = null;
      this.tui.requestRender();
    }, ms);
    this.flashTimer.unref?.();
  }

  // ---------- input ----------

  handleInput(data: string): void {
    void this.onKey(data).catch((e) => this.say(friendly(e), "err"));
  }

  handleMouse(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (ev.type === "wheel") {
      const d = (ev.wheelDelta ?? 0) > 0 ? 1 : -1;
      // Over the / menu, the wheel moves its highlight.
      const menu = this.box.menuRows && !this.overlay && ev.screenX >= this.box.left && ev.screenY >= this.menuTop() && ev.screenY < this.menuTop() + this.box.menuRows;
      if (menu) {
        this.input.moveMenu(d);
        this.tui.requestRender();
      } else if (this.leftW > 0 && ev.screenX < this.leftW && !this.overlay) this.select(this.sel + d);
      else if (this.overlay?.kind === "settings") this.moveSettings(d);
      else if (this.overlay?.kind === "pick") this.movePick(d);
      else this.scrollBy(d * 3);
      return { handled: true };
    }
    const box = this.boxMouse(ev);
    if (box) return box;
    if (ev.type !== "click" || ev.button !== "left") return undefined;
    const hit = this.hits.find((h) => h.row === ev.screenY && ev.screenX >= h.x0 && ev.screenX < h.x1);
    if (!hit) return undefined;
    void Promise.resolve(hit.act()).catch((e) => this.say(friendly(e), "err"));
    return { handled: true };
  }

  /** The / menu's first screen row, as last drawn: under the box's text, past a blank row. */
  private menuTop(): number {
    return this.box.textTop + this.box.textRows + 1;
  }

  /**
   * The mouse in the message box, as in a text box: a press places the cursor, a drag selects (copied on
   * release, like a selection in the conversation), a double-click selects a word and a triple-click its
   * line. A press anywhere else lets go of what's selected in the box.
   */
  private boxMouse(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
    const b = this.box;
    // The / menu's rows are below the text: those aren't the text's.
    const rows = this.input.isShowingAutocomplete() ? b.textTop + b.textRows - 1 : b.bottom;
    const inBox = !this.overlay && ev.button === "left" && ev.screenY >= b.top && ev.screenY <= rows && ev.screenX >= b.left;
    const at = () => this.input.posAt(ev.screenY - b.textTop, Math.max(0, ev.screenX - b.textX));
    if (ev.type === "press") {
      if (!inBox) {
        if (this.input.anchor) {
          this.input.deselect();
          this.tui.requestRender();
        }
        return undefined;
      }
      this.boxPress = at();
      this.input.select(this.boxPress, this.boxPress);
      return { handled: true };
    }
    if (ev.type === "drag" && this.boxPress) {
      // Like a selection on the screen, it takes in both the character pressed on and the one under the pointer.
      const p = at();
      const forward = !isBefore(p, this.boxPress);
      this.input.select(forward ? this.boxPress : this.input.after(this.boxPress), forward ? this.input.after(p) : p);
      return { handled: true };
    }
    if (ev.type === "release" && this.boxPress) {
      this.boxPress = null;
      this.copySelected();
      return { handled: true };
    }
    if (ev.type === "click" && inBox) {
      const p = at();
      if (ev.clickCount === 2) {
        const w = this.input.wordAt(p);
        this.input.select(w.start, w.end);
        this.copySelected();
      } else if (ev.clickCount === 3) {
        const line = this.input.getLines()[p.line] ?? "";
        this.input.select({ line: p.line, col: 0 }, { line: p.line, col: line.length });
        this.copySelected();
      }
      return { handled: true };
    }
    return undefined;
  }

  /** Copy what's selected in the message box, if anything, and say so as a selection on the screen does. */
  private copySelected(): boolean {
    const text = this.input.selectedText();
    if (!text) return false;
    void Promise.resolve(this.clipboard(text)).then(
      (ok) => this.tui.flash(ok ? "Copied!" : "Copy failed"),
      () => this.tui.flash("Copy failed"),
    );
    return true;
  }

  private typing(): boolean {
    return this.input.getText().length > 0;
  }

  private async onKey(data: string): Promise<void> {
    // Ctrl+C copies what's selected in the message box (Cmd+C is the terminal's own); with nothing selected it quits.
    if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.super("c"))) {
      if (!this.overlay && this.copySelected()) return;
      return matchesKey(data, Key.ctrl("c")) ? this.quit() : undefined;
    }
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
    // Ctrl+X cuts what's selected in the message box.
    if ((matchesKey(data, Key.ctrl("x")) || matchesKey(data, Key.super("x"))) && this.copySelected()) {
      this.input.deleteSelection();
      return this.tui.requestRender();
    }
    // The / menu is open: its keys (move, choose, close) go to it.
    if (this.input.isShowingAutocomplete() && [Key.up, Key.down, Key.enter, Key.tab, Key.escape].some((k) => matchesKey(data, k))) {
      this.input.handleInput(data);
      return this.tui.requestRender();
    }
    // The question you've gone to, if any: then the message box takes your answer to it.
    const q = this.onNewRow ? undefined : this.questionInFocus();
    // With questions open, Tab goes through them (and a card's own questions), then back to your message;
    // ⇧Tab the other way. Settings stay on → and Ctrl+P.
    if (!this.onNewRow && this.open.length && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) return this.tabQuestions(matchesKey(data, Key.tab) ? 1 : -1);
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.ctrl("p"))) return this.showSettings();
    const typing = this.typing();
    // → moves right, into the selected agent's settings (← or Esc comes back), as long as you aren't typing.
    if (!typing && !this.onNewRow && this.agent && matchesKey(data, Key.right)) return this.showSettings();
    if (!typing && data === "?") return this.show({ kind: "help" });

    if (matchesKey(data, Key.escape)) {
      // With text selected, Esc lets go of the selection first; pressed again, it clears the message.
      if (this.input.selection()) this.input.deselect();
      else if (q && this.choosing?.dismiss) this.choosing.dismiss = false;
      // On a question, Esc goes back to your message; what you'd picked or written for it stays.
      else if (q) this.leaveQuestions();
      else if (typing) this.input.setValue("");
      else if (this.linkIdx >= 0) this.linkIdx = -1;
      else if (this.pending.length) this.pending = [];
      return this.tui.requestRender();
    }
    // Shift+↑↓ (or Option+↑↓) scroll the messages a few lines; plain ↑↓ move between agents.
    // In a message of several lines, Shift+↑↓ select through its lines instead, as in a text box.
    if ((matchesKey(data, Key.shift("up")) || matchesKey(data, Key.shift("down"))) && this.input.getLines().length > 1) {
      this.input.handleInput(data);
      return this.tui.requestRender();
    }
    if (matchesKey(data, Key.shift("up")) || matchesKey(data, Key.alt("up"))) return this.scrollBy(-3);
    if (matchesKey(data, Key.shift("down")) || matchesKey(data, Key.alt("down"))) return this.scrollBy(3);
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      // In a message of several lines, ↑↓ move through its lines; otherwise between agents.
      if (this.input.getLines().length > 1) {
        this.input.handleInput(data);
        return this.tui.requestRender();
      }
      // On a question, they move between the open questions; down past the newest is your message again.
      if (q) return this.stepQuestion(matchesKey(data, Key.up) ? -1 : 1);
      return this.select(this.sel + (matchesKey(data, Key.up) ? -1 : 1));
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) return this.scrollBy(matchesKey(data, Key.pageUp) ? -PAGE : PAGE);
    if (!typing && matchesKey(data, Key.backspace) && this.pending.length) {
      this.pending.pop();
      return this.tui.requestRender();
    }
    // Number keys pick options only on the question you've gone to (with nothing typed for it yet): in
    // your message they're just numbers.
    if (q && !typing && /^[0-9]$/.test(data)) {
      const n = Number(data);
      const at = this.draft(q).at;
      if (n === 0 || n <= (questionParts(q)[at]?.options?.length ?? 0)) return this.choose(q, n, at);
    }
    // Shift+Enter / Ctrl+J start a new line in the message (checked before Enter, which Ctrl+J resembles).
    // Option+Enter too: many terminals send Shift+Enter exactly like Enter.
    if (!this.onNewRow && (data === "\n" || data === "\x1b\r" || getKeybindings().matches(data, "tui.input.newLine"))) {
      this.input.handleInput("\n");
      return this.tui.requestRender();
    }
    if (matchesKey(data, Key.enter)) {
      if (this.onNewRow) return this.create();
      if (q) return this.enterAnswer(q);
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
      // Your message comes back into the box first, so it's the one kept for this agent.
      if (this.asking) this.leaveQuestions();
      this.open = [];
      // A half-written message stays with the agent it was for, never sent to the next one by Enter.
      const text = this.input.getValue();
      if (text || this.pending.length) this.drafts.set(this.selName, { text, pending: this.pending });
      else this.drafts.delete(this.selName);
      this.sel = next;
      this.selName = this.agents[next]?.name ?? null;
      const draft = this.drafts.get(this.selName);
      this.input.setValue(draft?.text ?? "");
      this.pending = draft?.pending ?? [];
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
    // Past the top while older messages load (or are about to be drawn): remember how far, so the
    // view moves on into them once they're in, instead of losing the wheel steps made meanwhile.
    if (this.loadingOlder || this.keep) {
      if (cur + d < 0) this.pendingUp += cur + d;
      else if (d > 0 && this.pendingUp < 0) {
        // Back down: undo those first.
        const back = Math.min(d, -this.pendingUp);
        this.pendingUp += back;
        d -= back;
      }
    }
    this.scroll = Math.max(0, cur + d);
    if (this.scroll >= this.lastMax) this.scroll = Number.MAX_SAFE_INTEGER;
    if (this.scroll === 0 && d < 0 && !this.keep) void this.loadOlder();
    this.tui.requestRender();
  }

  private scrollToEnd(): void {
    this.anchor = null;
    this.scroll = Number.MAX_SAFE_INTEGER;
    this.tui.requestRender();
  }

  private attach(files: PendingAttachment[]): void {
    for (const f of files) if (!this.pending.some((p) => p.path === f.path)) this.pending.push(f);
    this.say(`Attached ${files.map((f) => f.name).join(", ")}. It goes with your next message.`, "ok");
  }

  /** The open question you've gone to, if it's still open. */
  private questionInFocus(): Message | undefined {
    return this.asking ? this.open.find((q) => q.id === this.asking) : undefined;
  }

  /** Your answer to the question you've gone to, as you make it; null in your message. */
  get choosing(): { id: string; at: number; picks: number[][]; notes: (string | undefined)[]; dismiss: boolean } | null {
    return this.asking ? (this.answers.get(this.asking) ?? null) : null;
  }

  /** Your answer to this question as you make it, started when you first go to it. */
  private draft(q: Message): NonNullable<App["choosing"]> {
    let d = this.answers.get(q.id);
    if (!d) this.answers.set(q.id, (d = { id: q.id, at: 0, picks: [], notes: [], dismiss: false }));
    return d;
  }

  /** What's in the box goes back where it belongs: your words for the question you're on, or your message. */
  private stash(): void {
    const d = this.choosing;
    if (d) d.notes[d.at] = this.input.getValue() || undefined;
    else this.held = this.input.getValue();
  }

  /** Go to an open question (question `at` of a card): the box now takes your answer to it, and its keys are live. */
  private focusQuestion(q: Message, at?: number): void {
    this.stash();
    this.asking = q.id;
    const d = this.draft(q);
    if (at != null && at !== d.at) {
      d.at = Math.min(Math.max(0, at), questionParts(q).length - 1);
      d.dismiss = false;
    }
    this.input.setValue(d.notes[d.at] ?? "");
    this.tui.requestRender();
  }

  /** Back to your message, as you left it. What you'd picked or written for the question stays with it (keep). */
  private leaveQuestions(keep = true): void {
    if (keep) this.stash();
    this.asking = null;
    this.input.setValue(this.held ?? "");
    this.held = null;
    this.tui.requestRender();
  }

  /** Tab: on through a card's questions, then the next open question, then back to your message (⇧Tab: back). */
  private tabQuestions(dir: 1 | -1): void {
    const q = this.questionInFocus();
    if (!q) {
      const to = dir > 0 ? this.open[0] : this.open.at(-1)!;
      return this.focusQuestion(to, dir > 0 ? 0 : questionParts(to).length - 1);
    }
    const at = this.draft(q).at + dir;
    if (at >= 0 && at < questionParts(q).length) return this.focusQuestion(q, at);
    const next = this.open[this.open.indexOf(q) + dir];
    if (!next) return this.leaveQuestions();
    this.focusQuestion(next, dir > 0 ? 0 : questionParts(next).length - 1);
  }

  /** ↑↓ on a question: the open question above or below; below the newest is your message again. */
  private stepQuestion(dir: 1 | -1): void {
    const q = this.questionInFocus();
    if (!q) return;
    const next = this.open[this.open.indexOf(q) + dir];
    if (next) this.focusQuestion(next);
    else if (dir > 0) this.leaveQuestions();
  }

  /**
   * Pick option n of question i on a card (0: dismiss it), waiting for Enter, as its number key does.
   * A question with one answer takes the new pick instead; otherwise each number turns its option on or off.
   */
  private choose(q: Message, n: number, i = this.draft(q).at): void {
    if (this.asking !== q.id || this.draft(q).at !== i) this.focusQuestion(q, i);
    const d = this.draft(q);
    d.dismiss = n === 0;
    if (n) {
      const had = d.picks[i] ?? [];
      d.picks[i] = questionParts(q)[i]?.single ? [n] : had.includes(n) ? had.filter((x) => x !== n) : [...had, n].sort((x, y) => x - y);
    }
    this.tui.requestRender();
  }

  /** On a card of several questions: go to the next (1) or previous (-1) one, keeping what you've answered. */
  private moveQuestion(q: Message, by: number, to?: number): void {
    this.focusQuestion(q, to ?? this.draft(q).at + by);
  }

  /** Enter on a question: dismiss it (0), go on to a card's next question, or send your answer. */
  private async enterAnswer(q: Message): Promise<void> {
    const d = this.draft(q);
    if (d.dismiss) return this.dismiss(q);
    d.notes[d.at] = this.input.getValue() || undefined;
    if (d.at < questionParts(q).length - 1) return this.moveQuestion(q, 1);
    return this.answer(q);
  }

  /** The question is done with: back to your message, and how many are still open, so none is forgotten. */
  private async closed(q: Message, said: string): Promise<void> {
    this.answers.delete(q.id);
    if (this.asking === q.id) this.leaveQuestions(false);
    this.scroll = Number.MAX_SAFE_INTEGER;
    await this.refresh();
    const left = this.open.length;
    this.say(left ? `${said} · ${left} more open: Tab to answer` : said, "ok");
  }

  private async dismiss(q: Message): Promise<void> {
    const a = this.agent;
    if (!a || this.onNewRow) return;
    await this.c.call("dismiss", { name: a.name, questionId: q.id });
    await this.closed(q, `Dismissed "${shortQuestion(q, 40)}". It won't wait on an answer.`);
  }

  /** What to press on the question you're on, under its card. */
  private questionHint(q: Message, at: number): string {
    const parts = questionParts(q);
    const p = parts[at];
    const n = p.options?.length ?? 0;
    const keys = n ? `Press ${n === 1 ? "1" : `1–${n}`} to ${p.single ? "choose" : n === 1 ? "pick it" : "pick one or more"}` : "";
    if (parts.length < 2) return n ? `${keys}, or type your answer below. 0 dismisses.` : "Type your answer below. 0 dismisses.";
    const last = at === parts.length - 1;
    return `Question ${at + 1} of ${parts.length}: ${keys ? `${keys.toLowerCase()}, or type` : "type"} below. ${last ? "Enter sends your answers" : "Enter goes to the next"} · 0 dismisses all.`;
  }

  /** Send your answer to a question: what you picked on each of its questions, and any words of your own. */
  private async answer(q: Message): Promise<void> {
    const a = this.agent;
    if (!a || this.onNewRow) return;
    const d = this.answers.get(q.id);
    const parts = questionParts(q);
    const labels = (i: number) => (d?.picks[i] ?? []).map((n) => optionLabel(parts[i].options?.[n - 1] ?? String(n)));
    const note = (i: number) => d?.notes[i]?.trim() || undefined;
    const what = `"${shortQuestion(q, 40)}"`;
    if (parts.length > 1) {
      const replies = parts.map((_, i) => ({ ...(d?.picks[i]?.length ? { choices: d.picks[i] } : {}), ...(note(i) ? { note: note(i) } : {}) }));
      const done = replies.filter((r) => r.choices || r.note).length;
      if (!done) return this.say("Nothing answered yet: pick an option or type an answer, or Esc to go back to your message.");
      await this.c.call("answer", { name: a.name, questionId: q.id, replies });
      return this.closed(q, done === parts.length ? `Answered all ${parts.length} questions of ${what}.` : `Answered ${done} of ${parts.length} questions of ${what}; the rest stay unanswered.`);
    }
    const picks = d?.picks[0] ?? [];
    const text = note(0);
    if (!picks.length && !text) return this.say("Pick an option or type your answer first.");
    await this.c.call("answer", { name: a.name, questionId: q.id, ...(picks.length > 1 ? { choices: picks } : picks.length ? { choice: picks[0] } : {}), ...(text ? { text } : {}) });
    await this.closed(q, `Answered ${what}: ${[...labels(0), ...(text ? [text] : [])].join(", ")}`);
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
      // Always a message, even with questions open: you answer one by going to it (Tab, or a click).
      await this.c.call("send", sent.length ? { name: a.name, text, attachments: sent.map((p) => p.path) } : { name: a.name, text });
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
    else if (now?.trouble) this.say(now.trouble.signIn ? `Sent. ${now.trouble.backend} isn't signed in: ${a.name} answers by itself once it is.` : `Sent. ${a.name} can't reach ${now.trouble.backend} right now: it answers once it can.`, "info");
  }

  private async create(): Promise<void> {
    const name = this.input.getValue().trim();
    const err = name ? validateName(name) : "Type a name for the agent first.";
    if (err) return this.say(err, "err");
    if (this.agents.some((a) => a.name === name)) return this.say(`There's already an agent called ${name}.`, "err");
    // Its settings come first, so a default backend or model that won't do can be changed before it's
    // made. Create is selected: Enter again makes it with the defaults, for anyone who doesn't mind.
    const o: SettingsOverlay = { kind: "settings", data: null, extra: null, idx: 0, draft: { name, patch: {} } };
    o.draft!.ready = this.loadDraft(o);
    const rows = this.settingsRows(o);
    this.selectSetting(o, rows, rows.findIndex((r) => r.key === "create"));
    this.show(o);
  }

  private async loadDraft(o: SettingsOverlay): Promise<void> {
    const d = o.draft!;
    // An older background process doesn't say: the rows show "default" and it uses its own.
    const [defaults, status] = await Promise.all([this.c.call("defaults").catch(() => undefined), this.c.call("backendStatus").catch(() => undefined)]);
    if (defaults && typeof defaults === "object") d.defaults = cleanDeep(defaults);
    if (Array.isArray(status)) d.status = cleanDeep(status);
    this.tui.requestRender();
  }

  /** The new agent's backend and model as they stand: what was chosen, else the defaults. */
  private draftRunsOn(d: NewAgentDraft): { name: string; backend: string; model: string | null } {
    const p = d.patch;
    return { name: d.name, backend: p.backend ?? d.defaults?.backend ?? "", model: "model" in p ? (p.model ?? null) : p.backend ? null : (d.defaults?.model ?? null) };
  }

  private async createDraft(o: SettingsOverlay): Promise<void> {
    const d = o.draft!;
    await d.ready;
    const { backend } = this.draftRunsOn(d);
    const missing = d.status?.find((b) => b.name === backend)?.missing;
    o.error = missing ? `${d.name} can't run here: ${missing} Or choose another backend above.` : undefined;
    if (!o.error) {
      try {
        await this.c.call("new", { name: d.name, ...d.patch }, 120_000); // checking a model name may start the backend
      } catch (e) {
        o.error = friendly(e);
      }
    }
    if (o.error) return this.tui.requestRender();
    if (this.overlay === o) this.overlay = null;
    const name = d.name;
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

  private async toggleVisibility(now: "public" | "private"): Promise<void> {
    const a = this.needAgent();
    if (!a) return;
    const next = now === "public" ? "private" : "public";
    await this.c.call("set", { name: a.name, visibility: next });
    this.say(next === "private" ? `${a.name} is private now: other agents can't see it or message it.` : `${a.name} is public now: other agents can see it and message it.`, "ok");
  }

  private async toggleReflect(on: boolean): Promise<void> {
    const a = this.needAgent();
    if (!a) return;
    await this.c.call("set", { name: a.name, reflect: !on });
    this.say(on ? `Reflect passes are off for ${a.name}.` : `Reflect passes are on for ${a.name}.`, "ok");
  }

  /** Auto-update is for all of Overtime, not one agent. */
  private async toggleAutoUpdate(on: boolean): Promise<void> {
    await this.c.call("setGlobal", { autoUpdate: !on });
    this.say(on ? "Overtime won't update itself. Update with: npm i -g @ukanwat/overtime" : "Overtime updates itself when a new version is out.", "ok");
  }

  /** Say once what the background process has to say about updating ("Updated to 0.7.9", or an update that needs you). */
  async showUpdateNotice(): Promise<void> {
    const n = await this.get<{ text: string; tone: "ok" | "err" } | null>("updateNotice").catch(() => null);
    if (n?.text) this.say(n.text, n.tone, n.tone === "err" ? 30_000 : 10_000);
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
    const rows = this.settingsRows(o);
    this.selectSetting(o, rows, rows.findIndex((r) => !!(r.field || r.run)));
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
    try {
      const g = await this.get<{ autoUpdate: boolean; version: string }>("globalSettings");
      o.global = typeof g?.autoUpdate === "boolean" ? g : undefined;
    } catch {
      o.global = undefined; // an older background process: no Overtime section
    }
  }

  private settingsRows(o: SettingsOverlay): SettingsRow[] {
    if (o.draft) return this.draftRows(o, o.draft);
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
      { label: "Visibility", heading: true },
      {
        label: "Other agents",
        key: "visibility",
        // An older background process doesn't say: shown as the default.
        value: (d?.visibility ?? "public") === "public" ? "public" : "private",
        note: (d?.visibility ?? "public") === "public" ? "they see it and can message it (Enter: make private)" : "hidden from them (Enter: make public)",
        stay: true,
        run: () => this.toggleVisibility(d?.visibility ?? "public"),
      },
      { label: "Memory", heading: true },
      {
        label: "Reflect passes",
        key: "reflect",
        // An older background process doesn't say: shown as the default.
        value: (d?.reflect ?? true) ? "on" : "off",
        note: (d?.reflect ?? true) ? `on ${d?.reflectModel ?? "its own model"}, while it's idle (Enter: turn off)` : "its memory is kept only by its own turns (Enter: turn on)",
        stay: true,
        run: () => this.toggleReflect(d?.reflect ?? true),
      },
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
              return { label: m.name, key: `mcp:${m.name}`, value, note: detail, stay: true, run: () => this.showMcpMenu(m, st) };
            }),
          ]
        : []),
      { label: "Control", heading: true },
      { label: "Wake now", stay: true, run: () => this.wake() },
      { label: a.status === "stopped" ? "Start" : "Stop", key: "stop", stay: true, note: a.status === "stopped" ? "it carries on from where it was" : "keeps its folder and messages", run: () => this.toggleStop() },
      { label: "Archive…", danger: true, run: () => this.confirmArchive() },
      { label: "Files", heading: true },
      { label: "Open its folder", note: tilde(a.dir), stay: true, run: () => this.openLink(a.dir) },
      { label: "AGENT.md", note: "who it is, its job and rules", stay: true, run: () => this.openLink(join(a.dir, "AGENT.md")) },
      { label: "Transcripts", note: "everything it was sent and did", stay: true, run: () => this.openLink(join(paths.meta(a.name), "runs")) },
      // For all of Overtime, not this agent: last.
      ...(o.global
        ? [
            { label: "Overtime", heading: true } as SettingsRow,
            {
              label: "Auto-update",
              key: "autoUpdate",
              value: o.global.autoUpdate ? "on" : "off",
              note: o.global.autoUpdate ? `updates itself; now ${o.global.version}` : `now ${o.global.version}; update by hand`,
              stay: true,
              run: () => this.toggleAutoUpdate(o.global!.autoUpdate),
            } as SettingsRow,
          ]
        : []),
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
        for (const k of x.skills) rows.push({ label: k.name, key: `skill:${k.name}`, note: `${k.source === "built-in" ? "" : `${k.source} · `}${k.description}`, stay: true, run: () => this.openLink(k.file) });
      }
    }
    return rows;
  }

  /** The new agent's settings step: the same rows as an agent's settings, and Create. */
  private draftRows(o: SettingsOverlay, d: NewAgentDraft): SettingsRow[] {
    const p = d.patch;
    const run = this.draftRunsOn(d);
    const missing = d.status?.find((b) => b.name === run.backend)?.missing;
    const budget = p.dailyBudgetUsd ?? d.defaults?.dailyBudgetUsd;
    const visibility = p.visibility ?? "public";
    return [
      { label: "Runs on", heading: true },
      { label: "Backend", field: "backend", value: run.backend || "default", note: missing ? "not installed" : p.backend ? "" : "the default" },
      { label: "Model", field: "model", value: run.model ?? "default", note: run.model ? "" : "the backend's choice" },
      { label: "Budget", heading: true },
      { label: "Daily budget", field: "budget", value: budget === undefined ? "default" : `$${fmtMoney(budget)} a day`, note: p.dailyBudgetUsd === undefined ? "the default" : "" },
      { label: "Visibility", heading: true },
      {
        label: "Other agents",
        key: "visibility",
        value: visibility,
        note: visibility === "public" ? "they see it and can message it (Enter: make private)" : "hidden from them (Enter: make public)",
        stay: true,
        run: () => void (p.visibility = visibility === "public" ? "private" : "public"),
      },
      { label: "Work", heading: true },
      { label: "Workspace", field: "workspace", value: tilde(p.workspace || paths.agent(d.name)), note: p.workspace ? "where its work lives" : "its own folder" },
      { label: "", heading: true },
      { label: `Create ${d.name}`, key: "create", stay: true, run: () => this.createDraft(o) },
    ];
  }

  private selectSetting(o: SettingsOverlay, rows: SettingsRow[], i: number): void {
    o.idx = i;
    o.sel = rows[i] ? rowKey(rows[i]) : undefined;
  }

  /**
   * Where the selected row is now. Found by what it is, not where it was: a refresh can add or remove
   * rows above it (a server, a skill), and the highlight and Enter must stay on the row you chose.
   */
  private settingsIdx(o: SettingsOverlay, rows: SettingsRow[]): number {
    const i = o.sel === undefined ? -1 : rows.findIndex((r) => rowKey(r) === o.sel);
    if (i >= 0) o.idx = i;
    return o.idx;
  }

  private moveSettings(d: number): void {
    const o = this.overlay;
    if (o?.kind !== "settings" || o.editing) return;
    const rows = this.settingsRows(o);
    for (let i = this.settingsIdx(o, rows) + d; i >= 0 && i < rows.length; i += d) {
      if (rows[i].field || rows[i].run) {
        this.selectSetting(o, rows, i);
        break;
      }
    }
    this.tui.requestRender();
  }

  private async activateSetting(o: SettingsOverlay, row: SettingsRow): Promise<void> {
    if (row.run) {
      if (!row.stay) this.overlay = null;
      await row.run();
      if (row.stay && this.overlay === o && !o.draft) await this.loadSettings(o);
      return this.tui.requestRender();
    }
    if (o.draft) {
      if (row.field === "backend") return this.showBackendPicker(true, o);
      if (row.field === "model") return this.showModelPicker(this.draftRunsOn(o.draft), this.draftRunsOn(o.draft).backend, true, o);
    }
    if (row.field === "backend") return this.showBackendPicker(true);
    if (row.field === "model") return this.showModelPicker(this.agent!, o.data?.backend ?? this.agent!.backend, true);
    if (row.field) {
      o.editing = row.field;
      o.error = undefined;
      const d = o.data;
      const p = o.draft?.patch;
      const v = p
        ? row.field === "budget"
          ? fmtMoney(p.dailyBudgetUsd ?? o.draft!.defaults?.dailyBudgetUsd ?? 0)
          : p.workspace
            ? tilde(p.workspace)
            : ""
        : row.field === "protect" ? (d?.protectOwn ?? []).map(tilde).join(", ") : row.field === "budget" ? fmtMoney(d?.dailyBudgetUsd ?? this.agent!.budgetUsd) : row.field === "tokens" ? (d?.dailyTokenBudget ? String(d.dailyTokenBudget) : "") : d && !d.workspaceIsDefault ? tilde(d.workspace) : "";
      setText(this.fieldInput, v);
      this.tui.requestRender();
    }
  }

  private async saveField(o: SettingsOverlay): Promise<void> {
    const raw = this.fieldInput.getValue().trim();
    const patch: Record<string, unknown> = {};
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
    if (o.draft) {
      // Nothing is made yet: kept for when Create is chosen.
      Object.assign(o.draft.patch, patch);
      o.editing = undefined;
      o.error = undefined;
      return this.tui.requestRender();
    }
    const a = this.agent!;
    await this.c.call("set", { name: a.name, ...patch });
    const label = FIELD_LABEL[o.editing!];
    o.editing = undefined;
    o.error = undefined;
    this.say(`${label} saved. It applies from ${a.name}'s next session.`, "ok");
    await this.loadSettings(o);
    await this.refresh();
  }

  /** Choose a backend, then one of its models: for the selected agent, or for the new agent's settings step (draft). */
  private async showBackendPicker(fromSettings: boolean, draft?: SettingsOverlay): Promise<void> {
    const a = draft ? this.draftRunsOn(draft.draft!) : this.needAgent();
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
      run: b.missing ? () => this.missingBackend(b.missing!, draft) : () => this.showModelPicker(a, b.name, fromSettings, draft),
    }));
    this.show({ kind: "pick", title: `${a.name} runs on`, items, idx: Math.max(0, backends.indexOf(a.backend)), back: draft ?? fromSettings });
  }

  /** A backend that isn't installed was chosen: the new agent's settings step comes back as it was, saying why. */
  private missingBackend(missing: string, draft?: SettingsOverlay): void {
    if (!draft) return this.say(missing, "err");
    draft.error = missing;
    this.show(draft);
  }

  private async showModelPicker(a: { name: string; backend: string; model: string | null }, backend: string, fromSettings: boolean, draft?: SettingsOverlay): Promise<void> {
    const title = `${backend} models for ${a.name}`;
    const back = draft ?? fromSettings;
    this.show({ kind: "pick", title, items: [], idx: 0, loading: `Asking ${backend} which models it offers…`, back });
    let models: { id: string; name: string }[] = [];
    try {
      models = cleanDeep(await this.c.call("models", { backend }, 90_000)) ?? [];
    } catch (e) {
      if (this.overlay?.kind === "pick" && this.overlay.title === title) this.say(`Couldn't get ${backend}'s models: ${friendly(e)}`, "err");
    }
    if (this.overlay?.kind !== "pick" || this.overlay.title !== title) return; // closed meanwhile
    const same = backend === a.backend;
    const apply = (model: string | null) => async () => {
      if (draft) {
        Object.assign(draft.draft!.patch, { backend, model });
        draft.error = undefined;
        return this.show(draft);
      }
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
    this.overlay = { kind: "pick", title, items, idx: cur >= 0 ? cur : 0, back };
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
      if (o.kind === "pick" && o.back) return typeof o.back === "object" ? this.show(o.back) : this.showSettings();
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
        const rows = this.settingsRows(o);
        const row = rows[this.settingsIdx(o, rows)];
        if (row) await this.activateSetting(o, row);
      } else if (o.draft) {
        // Nothing to wake or stop yet.
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

  /**
   * Where a mouse selection that starts at (x, y) may reach: the rows of the pane it started in, and on
   * each row only the columns that pane's text is in. So a copy from the conversation never picks up the
   * agent list, the divider or a message's bar, and one from the agent list stays in the list.
   * A selection that starts below the panes (the attachments, the footer) stays on its row. The message
   * box has its own selection (boxMouse), so the screen's never starts there.
   */
  selectionArea(x: number, y: number): { top: number; bottom: number; cols: (row: number) => [number, number] } | null {
    // The agent list runs down beside the message box, to the footer.
    if (this.leftW > 0 && x < this.leftW && y < this.listRows) return { top: 0, bottom: this.listRows - 1, cols: () => [0, this.leftW] };
    if (y >= this.paneRows) return { top: y, bottom: y, cols: () => (y < this.listRows && this.leftW > 0 ? [this.leftW + 1, this.width] : [0, this.width]) };
    const x0 = this.leftW > 0 ? this.leftW + 1 : 0;
    return { top: 0, bottom: this.paneRows - 1, cols: (row) => this.textCols.get(row) ?? [x0, this.width] };
  }

  // ---------- rendering ----------

  render(width: number): string[] {
    this.hits = [];
    this.textCols.clear();
    this.motion = Infinity;
    const rows = Math.max(8, this.term.rows);
    const narrow = width < NARROW;
    // The agent list grows a little on wide terminals, so their status lines have room to be read.
    const leftW = narrow ? 0 : Math.min(width >= 150 ? 42 : 34, Math.max(26, Math.floor(width * 0.26)));
    const rightW = narrow ? width : width - leftW - 1;
    // The message box and its attachments belong to the conversation: as wide as its pane, so the agent
    // list and its divider run on down to the footer.
    const x0 = narrow ? 0 : leftW + 1;
    const chipsH = this.pending.length && !this.onNewRow ? 1 : 0;
    const composer = this.renderComposer(rightW, rows >= 16);
    const composerH = composer.length;
    const bodyH = Math.max(1, rows - TOP - chipsH - composerH - 1);
    this.leftW = leftW;
    this.paneRows = TOP + bodyH;
    this.listRows = rows - 1;
    this.width = width;

    // The gap above the panes is padding only: the divider between them still runs to the top edge.
    const out: string[] = Array(TOP).fill(narrow ? "" : " ".repeat(leftW) + faint("│"));
    const left = narrow ? [] : this.renderAgents(leftW, bodyH + chipsH + composerH);
    const lp = (i: number) => (narrow ? "" : fit(left[i] ?? "", leftW) + faint("│"));
    const right = this.renderRight(rightW, bodyH, x0, narrow);
    for (let i = 0; i < bodyH; i++) {
      const r = right[i] ?? "";
      out.push(typeof r === "string" ? lp(i) + fit(r, rightW) : lp(i) + "    " + r.image);
    }
    if (chipsH) out.push(lp(bodyH) + this.renderChips(rightW, TOP + bodyH, x0));
    const b = this.box;
    b.top = out.length;
    b.bottom = out.length + composerH - 1;
    b.left = x0;
    b.textTop += b.top;
    b.textX += x0;
    // The / menu's items, under the text past a blank row: a click on one chooses it, as Enter does.
    const shown = b.menuRows ? this.input.menuShown() : { start: 0, end: 0 };
    for (let i = shown.start; i < shown.end; i++) {
      const pick = () => {
        this.input.pickMenu(i);
        this.tui.requestRender();
      };
      this.hits.push({ row: this.menuTop() + i - shown.start, x0: b.textX, x1: b.textX + b.textW, act: pick });
    }
    composer.forEach((l, i) => out.push(lp(bodyH + chipsH + i) + fit(l, rightW)));
    out.push(fit(this.renderFooter(width), width));
    return out;
  }

  /** How often to draw the next frame, in ms: as often as what's on screen moves; null when nothing does. */
  frameMs(): number | null {
    // The loading spinners and live steps turn while anything is live.
    const live = this.live.size || this.agents.some((a) => a.status === "working" || a.helpersRunning) ? 100 : Infinity;
    const ms = Math.min(this.motion, live);
    return ms === Infinity ? null : ms;
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
      if (idx === this.agents.length) {
        lines.push(this.selRow(` ${accent("+")} ${accent(on ? bold("New agent") : "New agent")}`, w, on), this.selRow(`   ${muted("create one")}`, w, on), "");
        continue;
      }
      const a = this.agents[idx];
      // Line one: its state as a circle and a word, either side of its name. Line two: what it says it's
      // doing (that changes rarely; the step it's on now is in the conversation), or why it isn't.
      const unread = a.unread && !a.waiting ? " " + accent(`${a.unread}`) : "";
      const name = on ? (hasTints() ? bold(a.name) : accent(bold(a.name))) : a.name;
      const l1 = " " + this.glyph(a) + " " + spread(name + unread, stateWord(a) + " ", w - 3);
      const l2 = "   " + this.agentStatus(a, w - 4);
      lines.push(this.selRow(l1, w, on), this.selRow(l2, w, on), "");
    }
    if (count > visible) lines.push(muted(`   ${Math.min(this.sel + 1, count)} of ${count}`));
    return lines;
  }

  /** An agent's state glyph, noting how soon it next changes so the frame timer keeps up with it. */
  private glyph(a: AgentSummary): string {
    const g = stateGlyph(a);
    if (g.period) this.motion = Math.min(this.motion, g.period);
    return g.glyph;
  }

  /** The agent list's second line: what it says it's doing, or why it isn't doing anything. */
  private agentStatus(a: AgentSummary, w: number): string {
    const p = statusParts(a);
    if (p.kind === "trouble") return red(cut(a.lastError && !a.trouble?.signIn ? `last turn failed: ${a.lastError}` : p.word, w));
    if (p.kind === "paused" || p.kind === "new") return muted(cut(p.detail, w));
    // A stopped agent's last status line would read as if it were still at it.
    if (p.kind === "stopped") return "";
    // Working without a line of its own: what the turn is about, in italics as Overtime's words, not its.
    if (!a.ownStatus && a.turnAbout) return italic(muted(cut(a.turnAbout, w)));
    return muted(cut(a.ownStatus, w));
  }

  /**
   * The selected agent: its rows on a tint leaning to the accent, edge to edge, so the two rows read as one
   * block with no seam (a bar of block glyphs shows a gap between rows in some terminals). Without tints, its
   * name is in the accent instead.
   */
  private selRow(line: string, w: number, on: boolean): string {
    return on && hasTints() ? picked(line, w) : line;
  }

  private renderRight(w: number, h: number, x: number, narrow: boolean): Line[] {
    if (this.onNewRow) {
      // The new agent's settings step, and its pickers, where its conversation will be.
      if (!this.overlay) return this.renderNew(w, x, narrow);
      const body = this.overlay.kind === "settings" ? this.renderSettings(this.overlay, w, x, TOP, h) : this.renderOverlay(w, h, x, TOP);
      return body.slice(0, h);
    }
    const a = this.agent!;
    const head = this.renderAgentHeader(a, w, x, narrow);
    const bodyH = Math.max(1, h - head.length);
    let body: Line[];
    if (this.overlay?.kind === "settings") body = this.renderSettings(this.overlay, w, x, TOP + head.length, bodyH);
    else if (this.overlay) body = this.renderOverlay(w, bodyH, x, TOP + head.length);
    else {
      // Open questions pinned at the end, above the message box: the conversation scrolls above them.
      const pinned = this.renderQuestions(w, Math.max(0, Math.min(bodyH - 4, Math.floor(bodyH * 0.7))));
      const msgH = bodyH - pinned.lines.length;
      body = [...this.renderMessages(a, w, msgH, x, TOP + head.length).slice(0, msgH), ...pinned.lines];
      while (body.length < bodyH) body.splice(msgH, 0, "");
      const top = TOP + head.length + bodyH - pinned.lines.length;
      for (const h of pinned.hits) this.hits.push({ row: top + h.line, x0: x + (h.x0 ?? 0), x1: Math.min(x + w, x + (h.x1 ?? w)), act: h.act });
      pinned.lines.forEach((_, i) => this.textCols.set(top + i, [x + 4, x + w]));
    }
    return [...head, ...body.slice(0, bodyH)];
  }

  private renderNew(w: number, x: number, narrow: boolean): Line[] {
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
    if (err) lines.push(...wrap(`${red("✗")} ${red(err)}`));
    else if (name) {
      // The way on: a filled button in the accent, which a click presses as Enter does.
      const btn = inverse(accent(bold(`  Create ${name}  `)));
      const bw = visibleWidth(btn);
      this.hits.push({ row: TOP + lines.length, x0: x + 3, x1: x + 3 + bw, act: () => this.create() });
      lines.push(pad(`${btn}  ${muted("⏎ or press Enter")}`));
    }
    else lines.push(pad(muted("Lowercase letters, digits and dashes, e.g. repo-keeper.")));
    lines.push("", ...wrap(muted("Agents keep running when you close this window. Press ? for keys.")));
    return lines;
  }

  private renderAgentHeader(a: AgentSummary, w: number, x: number, narrow: boolean): string[] {
    const p = statusParts(a);
    // Each thing once: line one is its state and, while working, the step it's on right now; line two
    // is its own status line. (The list on the left has the short version for scanning.)
    const own = a.status !== "new" && a.status !== "stopped" ? a.ownStatus : "";
    // When it wakes stays next to "asleep" and "needs you" even with a status line of its own under it.
    const now = p.kind === "working" ? this.mainLive(a.name)?.step ?? p.detail : own && p.kind !== "asleep" && p.kind !== "needs" ? "" : p.detail;
    const state = `${this.glyph(a)} ${p.color(p.word)}${now ? muted(` · ${now}`) : ""}`;
    const open = this.overlay?.kind === "settings";
    const btn = open ? inverse(" Settings ") : `${muted("⚙")} Settings ${muted("→")}`;
    const btnW = visibleWidth(btn) + 1;
    this.hits.push({ row: TOP, x0: x + w - btnW, x1: x + w, act: () => (open ? ((this.overlay = null), this.tui.requestRender()) : this.showSettings()) });
    const where = narrow && this.agents.length > 1 ? muted(`  ${this.sel + 1}/${this.agents.length} ↑↓`) : "";
    const lines = [spread(`  ${bold(a.name)}${where}  ${state}`, btn + " ", w)];
    const doing = own ? italic(muted(own)) : "";
    lines.push(spread(`  ${doing}`, muted(`${money(a)}  ·  ${a.backend}${a.model ? ` · ${a.model}` : ""}`) + " ", w));
    if (a.trouble?.signIn && a.status !== "working") lines.push(fit(`  ${red("Not signed in:")} ${muted(`sign in to ${a.trouble.backend} in a terminal; ${a.name} carries on by itself once you have.`)}`, w));
    else if (a.lastError && a.status !== "working") lines.push(fit(`  ${red("Last turn failed:")} ${muted(a.lastError)}`, w));
    lines.push(faint("─".repeat(w)));
    return lines;
  }

  /**
   * The open questions, pinned together just above the message box, newest last: one line each, and the one
   * you've gone to opened up with its options. At most maxH rows, so the conversation always keeps some room:
   * a long question's details give way first (they're in the conversation), then the other questions' lines.
   */
  private renderQuestions(w: number, maxH: number): { lines: string[]; hits: { line: number; x0?: number; x1?: number; act: () => void }[] } {
    const open = this.open;
    if (!open.length || maxH < 2) return { lines: [], hits: [] };
    const inner = Math.max(12, w - 6);
    const focus = this.questionInFocus();
    const line = (s: string) => `  ${yellow("┃")} ${s}`;
    const wrap = (s: string, width: number) => (s.trim() ? wrapTextWithAnsi(s, Math.max(8, width)) : [""]);
    type Row = { s: string; act?: () => void; x0?: number; x1?: number; detail?: boolean };
    // One line for a question you aren't on: what it asks, its options or how many questions, when.
    const row = (q: Message): Row => {
      const parts = questionParts(q);
      const d = this.answers.get(q.id);
      // An answer you've started (and left with Esc): marked up front, where a long line can't cut it off.
      const begun = d && (d.picks.some((p) => p?.length) || d.notes.some((n) => n?.trim())) ? ` ${accent("✎")}` : "";
      const what = parts.length > 1 ? `${parts.length} questions` : (q.options ?? []).map(optionLabel).join(" / ");
      return { s: line(spread(`${yellow("?")}${begun} ${shortQuestion(q, 200)}${what ? muted(`  · ${what}`) : ""}`, muted(stamp(q.t)) + " ", w - 5)), act: () => this.focusQuestion(q) };
    };
    // The one you're on: its options live (numbers, clicks), the question of a card you're on opened up.
    const opened = (q: Message): Row[] => {
      const rows: Row[] = [];
      const d = this.draft(q);
      const parts = questionParts(q);
      const card = parts.length > 1;
      const hq = headed(q, "A question for you");
      const ind = card ? "  " : "";
      rows.push({ s: line(spread(`${yellow(bold("▸ ?"))} ${bold(card ? q.title?.trim() || `${parts.length} questions for you` : hq.title)}`, muted(stamp(q.t)) + " ", w - 5)) });
      if (!card && hq.body) {
        // Its details, briefly: the whole of them is in the conversation, where it was asked.
        const more = wrap(hq.body.replace(/\s+/g, " "), inner - 6);
        more.slice(0, 2).forEach((l, i) => rows.push({ s: line(`  ${muted(i === 1 && more.length > 2 ? cut(l, inner - 8) + "…" : l)}`), detail: true }));
      }
      parts.forEach((p, i) => {
        const cur = i === d.at;
        const picks = d.picks[i] ?? [];
        if (card) {
          const done = !cur && (picks.length || d.notes[i]?.trim()) ? `  ${accent("✓")}` : "";
          const head = cur ? `${yellow(bold(`▸ Q${i + 1}`))}  ${bold(p.text)}` : `${muted(`  Q${i + 1}`)}  ${p.text}`;
          // A question you aren't on stays one line; a click goes to it.
          (cur ? wrap(head + done, inner - 4) : [head + done]).forEach((l) => rows.push({ s: line(l), act: () => this.moveQuestion(q, 0, i) }));
          if (!cur) return;
        }
        const rec = recommendedOption(p.options, p.recommendation);
        if (p.why) for (const l of wrap(muted(p.why), inner - 6 - ind.length)) rows.push({ s: line(`  ${ind}${l}`), detail: true });
        // A recommendation that names an option is marked on it; anything else gets its own line.
        if (p.recommendation && rec < 0) for (const l of wrap(`${bold("I'd suggest:")} ${p.recommendation}`, inner - 6 - ind.length)) rows.push({ s: line(`  ${ind}${l}`), detail: true });
        const last = Math.max(0, ...picks);
        (p.options ?? []).forEach((o, k) => {
          const n = k + 1;
          const on = picks.includes(n);
          const label = optionLabel(o);
          const num = on ? inverse(bold(yellow(` ${n} `))) : inverse(accent(` ${n} `));
          // Picks are ticked too, so which are on shows before Enter, even without colour.
          const shown = `${num} ${on ? bold(label) : label}${on ? ` ${yellow("✓")}` : ""}`;
          const hint = on && !card && !d.dismiss && n === last ? `  ${yellow("← Enter to answer")}` : "";
          // A click picks the option, like its number key; Enter answers. Only where it's written.
          rows.push({ s: line(`  ${ind}${shown}${k === rec ? muted("  · suggested") : ""}${hint}`), act: () => this.choose(q, n, i), x0: 6 + ind.length, x1: 6 + ind.length + visibleWidth(shown) });
        });
        const own = d.notes[i]?.trim();
        if (own && !cur) rows.push({ s: line(`  ${ind}${accent("✎")} ${cut(own, inner - 8)}`) });
      });
      const what = card ? "Dismiss these questions" : "Dismiss this question";
      const shown = `${d.dismiss ? inverse(bold(yellow(" 0 "))) : muted(" 0 ")} ${d.dismiss ? bold(what) : muted(what)}`;
      rows.push({ s: line(`  ${shown}${d.dismiss ? `  ${yellow("← Enter to dismiss")}` : ""}`), act: () => this.choose(q, 0), x0: 6, x1: 6 + visibleWidth(shown) });
      rows.push({ s: line(muted(cut(this.questionHint(q, d.at), inner - 2))), detail: true });
      return rows;
    };
    const label = `${open.length === 1 ? "A question" : `${open.length} questions`} for you${focus ? "" : " · Tab to answer"}`;
    const head: Row = { s: `${faint("──")} ${yellow(label)} ${faint("─".repeat(Math.max(0, w - visibleWidth(label) - 4)))}` };
    const at = focus ? open.indexOf(focus) : open.length;
    let above = open.slice(0, at).map(row);
    let card = focus ? opened(focus) : [];
    let below = focus ? open.slice(at + 1).map(row) : [];
    const size = () => 1 + above.length + card.length + below.length;
    // Too tall: details first, then the other questions fold into one line each side, then the card's top.
    if (size() > maxH) card = card.filter((r) => !r.detail);
    const fold = (rows: Row[], word: string): Row[] => (rows.length > 1 ? [{ s: line(muted(`${word} ${rows.length} more open question${rows.length === 1 ? "" : "s"}`)) }] : rows);
    if (size() > maxH && focus) [above, below] = [fold(above, "↑"), fold(below, "↓")];
    if (size() > maxH && !focus) above = [...fold(above.slice(0, above.length - (maxH - 2)), "↑"), ...above.slice(-(maxH - 2))];
    if (size() > maxH) card = [card[0], ...card.slice(card.length - Math.max(0, maxH - 2 - above.length - below.length))];
    const rows = [head, ...above, ...card, ...below].slice(0, maxH);
    const hits = rows.flatMap((r, i) => (r.act ? [{ line: i, x0: r.x0, x1: r.x1, act: r.act }] : []));
    return { lines: rows.map((r) => r.s), hits };
  }

  /** The DM: the agent's words plain, yours on a tinted panel with a bar, questions and alerts as cards. */
  private renderMessages(a: AgentSummary, w: number, h: number, x: number, top: number): Line[] {
    const body: Line[] = [];
    const bodyHits: { line: number; x0?: number; x1?: number; act: () => void | Promise<void> }[] = [];
    const inner = Math.max(12, w - 6);
    const wrap = (s: string, width = inner) => (s.trim() ? wrapTextWithAnsi(s, Math.max(8, width)) : [""]);
    const paras = (s: string, width = inner) => s.split("\n").flatMap((p) => wrap(p, width));
    let t = 0;
    let lastDay = "";
    let prev: Message | undefined;
    let lastStart = 0;

    this.linkLine = -1;
    this.msgLine.clear();
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
      this.msgLine.set(m.id, body.length);
      const regroup = !prev || prev.from !== m.from || prev.kind !== "message" || m.kind !== "message" || new Date(m.t).getTime() - new Date(prev.t).getTime() > REGROUP_MIN * 60_000;

      if (m.from === "you") {
        // Yours: a tinted panel behind an accent bar, like Grok CLI's prompt blocks. The bar is in the same
        // column as every other message's rule (two in), so the left edges of the conversation line up.
        const row = (s: string) => "  " + accent("┃") + (hasTints() ? panel(" " + s, w - 4) : " " + s);
        if (prev && body.at(-1) !== "") body.push("");
        // An answer says which question it was for: several can be open, and others may have come in between.
        const asked = m.replyTo ? this.messages.find((x) => x.id === m.replyTo) : undefined;
        const answered = asked ? `answered ${cut(`"${shortQuestion(asked)}"`, Math.max(10, w - 25))}` : "answered";
        body.push(row(spread(m.replyTo ? muted(answered) : "", muted(stamp(m.t)) + " ", w - 5)));
        // The words one space past the bar, as in every other kind of message.
        if (m.text) for (const l of paras(m.text, w - 7)) body.push(row(l));
        t = this.pushExtras(m, body, bodyHits, w - 2, t, row);
        body.push(row(""), "");
      } else if (m.kind === "question") {
        const open = !m.answer;
        const line = (s: string) => `  ${open ? yellow("┃") : faint("┃")} ${s}`;
        if (body.length && body.at(-1) !== "") body.push("");
        const hq = headed(m, "A question for you");
        const parts = questionParts(m);
        const card = parts.length > 1;
        const title = card ? m.title?.trim() || `${parts.length} questions for you` : hq.title;
        // On a card, each question's options sit under its "Q1" label.
        const ind = card ? "  " : "";
        if (!open && m.answer) {
          // Answered: each question and all its options, the ones you chose marked and the rest muted, so you
          // can see what you picked from. Read-only: no clicks or number keys, so it never looks still open.
          const ans = m.answer;
          for (const l of paras(`${muted("?")} ${muted(title)}  ${muted(stamp(m.t))}`, inner - 4)) body.push(line(l));
          parts.forEach((p, i) => {
            const r = ans.closed ? {} : replyTo(ans, i);
            const chosen = (r.choices ?? []).filter((n) => p.options?.[n - 1]);
            if (card) {
              body.push(line(""));
              for (const l of paras(muted(`Q${i + 1}  ${p.text}`), inner - 4)) body.push(line(l));
            }
            if (p.options?.length) {
              if (!card) body.push(line(""));
              p.options.forEach((o, k) => {
                const n = k + 1;
                const on = chosen.includes(n);
                // The same "n  label" as an unanswered option, behind a two-column gutter for the ✓; long labels
                // wrap under themselves so no line runs past the edge.
                const lead = `${n}  `;
                const tag = "  · your answer";
                const lines = wrap(optionLabel(o), inner - 6 - ind.length - lead.length - (on ? tag.length : 0));
                lines.forEach((l, j) => {
                  const text = (j ? " ".repeat(lead.length) : lead) + l;
                  if (!on) body.push(line(`${ind}  ${muted(text)}`));
                  else body.push(line(`${ind}${j ? "  " : `${accent("✓")} `}${accent(bold(text))}${j === lines.length - 1 ? muted(tag) : ""}`));
                });
              });
            }
            if (ans.closed) return;
            if (!chosen.length && !r.note && card) body.push(line(muted(`${ind}  (left unanswered)`)));
            else if (!chosen.length) {
              // In your own words (older answers kept only the whole text).
              if (p.options?.length && !card) body.push(line(""));
              for (const l of paras(`${ind}${accent("✓")} You answered: ${r.note ?? ans.text ?? ""}`, inner - 4)) body.push(line(l));
            } else if (r.note) {
              if (!card) body.push(line(""));
              for (const l of paras(muted(r.note), inner - 4 - ind.length)) body.push(line(ind + l));
            }
          });
          if (ans.closed) {
            if (parts.some((p) => p.options?.length)) body.push(line(""));
            // Muted like the rest of the closed card, never red: a withdrawal isn't a denial.
            for (const l of paras(closedLine(ans, a.name), inner - 4)) body.push(line(muted(l)));
          } else if (card && ans.note) {
            body.push(line(""));
            for (const l of paras(muted(ans.note), inner - 4)) body.push(line(l));
          }
          t = this.pushExtras(m, body, bodyHits, w, t, line);
          body.push("");
          prev = m;
          continue;
        }
        // Still open: what was asked, read-only, where it was asked. You answer it in the stack pinned above
        // the message box, so it never scrolls away; once answered, this is where the answer shows.
        for (const l of paras(`${yellow("?")} ${bold(title)}  ${muted(stamp(m.t))}`, inner - 4)) body.push(line(l));
        if (!card && hq.body) for (const l of markdownLines(hq.body, inner - 4)) body.push(line(linkify(l, m.links)));
        parts.forEach((p, i) => {
          if (card) {
            body.push(line(""));
            for (const l of paras(`${muted(`Q${i + 1}`)}  ${p.text}`, inner - 4)) body.push(line(l));
          }
          if (p.why) for (const l of paras(muted(p.why), inner - 4 - ind.length)) body.push(line(ind + l));
          if (p.recommendation) for (const l of paras(`${bold("I'd suggest:")} ${p.recommendation}`, inner - 4 - ind.length)) body.push(line(ind + l));
          if (p.options?.length) {
            if (!card) body.push(line(""));
            p.options.forEach((o, k) => body.push(line(muted(`${ind}${k + 1}  ${optionLabel(o)}`))));
          }
        });
        body.push(line(""));
        body.push(line(yellow(`↓ Waiting for your answer, pinned below${this.asking === m.id ? "" : " · Tab to answer"}`)));
        t = this.pushExtras(m, body, bodyHits, w, t, line);
        body.push("");
      } else if (m.kind === "agent-message") {
        // Between this agent and another: quiet, labelled with both names, never in the agent's own voice.
        if (body.length && body.at(-1) !== "") body.push("");
        body.push(`  ${muted(bold(`${m.fromAgent} → ${m.toAgent}`))}  ${muted(stamp(m.t))}${muted("  · between agents")}`);
        const ind = (s: string) => "  " + faint("│") + " " + s;
        for (const l of paras(linkify(muted(m.text), m.links), inner)) body.push(ind(l));
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
    const waitingOnIt = [...this.messages].reverse().find((m) => !m.closes && m.kind !== "agent-message")?.from === "you";
    if (live && waitingOnIt) {
      if (body.length && body.at(-1) !== "") body.push("");
      body.push(`  ${accent(bold(a.name))}  ${muted(`${spinner()} ${live.step ?? "thinking…"}`)}`);
    }
    body.push("");

    const maxScroll = Math.max(0, body.length - h);
    this.lastMax = maxScroll;
    let s: number;
    if (this.keep) {
      const now = this.msgLine.get(this.keep.id);
      if (now != null) {
        this.scroll = Math.min(maxScroll, Math.max(0, this.keep.top + now - this.keep.line + this.pendingUp));
        if (this.scroll >= maxScroll) this.scroll = Number.MAX_SAFE_INTEGER;
        this.anchor = null;
      }
      this.keep = null;
      this.pendingUp = 0;
    }
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
      // A one-time jump: a long new message from its start. (Open questions need none: they're pinned below.)
      const target = body.length - lastStart > h ? lastStart - 1 : maxScroll;
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
    // The hints cover a row of the conversation: a click there scrolls, never does what was under it.
    const hintRows = new Set<number>();
    if (s > 0 && view.length > 1 && typeof view[0] === "string") {
      view[0] = muted(`   ↑ ${s} line${s === 1 ? "" : "s"} above · ⇧↑`);
      hintRows.add(0);
      this.hits.push({ row: top, x0: x, x1: x + w, act: () => this.scrollBy(-PAGE) });
    }
    if (s < maxScroll && view.length === h && h > 1) {
      view[h - 1] = muted(`   ↓ newer below · ⇧↓`);
      hintRows.add(h - 1);
      this.hits.push({ row: top + h - 1, x0: x, x1: x + w, act: () => this.scrollToEnd() });
    }
    for (const bh of bodyHits) {
      const row = bh.line - s;
      if (row >= 0 && row < h && !hintRows.has(row)) this.hits.push({ row: top + row, x0: x + (bh.x0 ?? 0), x1: Math.min(x + w, x + (bh.x1 ?? w)), act: bh.act });
    }
    // Where each row's words start, past the bar the message is drawn with, so a selection copies only the words.
    view.forEach((v, i) => {
      const g = typeof v === "string" ? (/^  [┃│] /.exec(stripTerminalSequences(v))?.[0].length ?? 0) : 0;
      if (g) this.textCols.set(top + i, [x + g, x + w]);
    });
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
  private framed(title: string, body: string[], bodyHits: { line: number; x0?: number; x1?: number; act: () => void | Promise<void> }[], w: number, x: number, top: number, h: number): Line[] {
    const indent = w < 50 ? 1 : 2;
    const bw = Math.max(20, Math.min(w - indent * 2, 92));
    for (const hh of bodyHits) {
      const row = top + 2 + hh.line;
      // A panel taller than the pane is cut off at its bottom: rows below that are the message box's.
      if (row < top + h) this.hits.push({ row, x0: x + indent + 2 + (hh.x0 ?? 0), x1: hh.x1 != null ? x + indent + 2 + hh.x1 : x + indent + bw - 2, act: hh.act });
    }
    body.forEach((_, i) => this.textCols.set(top + 2 + i, [x + indent + 2, x + indent + bw - 2]));
    return ["", ...box(title, body, bw).map((l) => " ".repeat(indent) + l)];
  }

  /** The inside width of a framed panel in a pane of width w. */
  private innerW(w: number): number {
    const indent = w < 50 ? 1 : 2;
    return Math.max(20, Math.min(w - indent * 2, 92)) - 4;
  }

  private renderSettings(o: SettingsOverlay, w: number, x: number, top: number, h: number): Line[] {
    const title = o.draft ? `New agent · ${o.draft.name}` : `${this.agent?.name ?? ""} · settings`;
    const iw = this.innerW(w);
    if (!o.data && !o.error && !o.draft) return this.framed(title, ["", muted(`${spinner()} Loading settings…`), ""], [], w, x, top, h);
    const rows = this.settingsRows(o);
    const labelW = 16;
    let valueW = Math.min(30, Math.max(12, ...rows.filter((r) => r.field).map((r) => visibleWidth(r.value ?? "") + 2)));
    // Explanations only where they fit whole-ish; a narrow panel shows clean values instead of fragments.
    const notes = iw - 2 - labelW - valueW >= 14;
    if (!notes) valueW = Math.max(8, iw - 2 - labelW);
    const body: string[] = [];
    const lineOf: number[] = [];
    const idx = this.settingsIdx(o, rows);
    rows.forEach((r, i) => {
      if (r.heading) {
        body.push("", ...(r.label ? [muted(r.label.toUpperCase())] : []));
        return;
      }
      const on = i === idx;
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
    if (o.error && !o.editing) body.push("", ...wrapTextWithAnsi(red(o.error), iw - 2).map((l) => "  " + l));
    body.push("");
    // Keep the selected row in view.
    const bh = Math.max(3, h - 3);
    const selLine = lineOf[idx] ?? 0;
    const start = Math.max(0, Math.min(selLine - Math.floor(bh / 2), body.length - bh));
    const hits: { line: number; act: () => Promise<void> }[] = [];
    rows.forEach((r, i) => {
      if (!(r.field || r.run) || lineOf[i] == null) return;
      const line = lineOf[i] - start;
      if (line >= 0 && line < bh)
        hits.push({
          line,
          act: async () => {
            this.selectSetting(o, rows, i);
            await this.activateSetting(o, r);
          },
        });
    });
    const shown = body.slice(start, start + bh);
    // Say when there's more than fits, rather than cutting it off silently.
    if (start + bh < body.length) shown[shown.length - 1] = muted("  ↓ more below");
    if (start > 0) shown[0] = muted("  ↑ more above");
    return this.framed(title, shown, hits.filter((hh) => hh.line > (start > 0 ? 0 : -1) && hh.line < (start + bh < body.length ? bh - 1 : bh)), w, x, top, h);
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
        ...row("→ or Ctrl+P", "open the selected agent's settings (Tab too, when no question is open)"),
        ...row("← or Esc", "close a panel"),
        ...row("⇧↑ ⇧↓", "scroll the messages (Option+↑↓, PgUp PgDn and the mouse wheel work too)"),
        "",
        muted("MESSAGES"),
        ...row("type, Enter", "write a message and send it"),
        ...row("⌥/⇧ Enter", "a new line in the message (Ctrl+J works too); pasted text keeps its lines"),
        ...row("⇧ arrows", "select in the message, by word with ⌥ too; or drag, double-click a word, Ctrl+A twice for all"),
        ...row("Ctrl+C Ctrl+X", "copy or cut what's selected in the message; typing replaces it; Ctrl+Z undoes"),
        "",
        muted("QUESTIONS (pinned above the message box)"),
        ...row("Tab ⇧Tab", "go to the open questions, through a card's questions, and back to your message"),
        ...row("↑ ↓", "on a question: the one above or below; below the newest is your message"),
        ...row("1–9, Enter", "pick its options (several, unless it takes one), or type your answer, then Enter"),
        ...row("0, Enter", "dismiss it"),
        ...row("Esc", "back to your message; what you picked stays, for when you come back"),
        ...row("drag a file", "attach it to your next message"),
        ...row("Ctrl+L", "step through links and files; Enter opens one"),
        "",
        muted("SHORTCUTS"),
        ...row("Ctrl+N", "new agent"),
        ...row("Ctrl+R", "wake the agent now"),
        ...row("Ctrl+S", "stop or start the agent"),
        ...row("Ctrl+T", "change its backend and model"),
        ...row("Ctrl+O", "open its folder"),
        ...row("Ctrl+C", "quit (your agents keep running), when nothing in the message is selected"),
        "",
      ];
      return this.framed("Keys", body.slice(0, Math.max(3, h - 3)), [], w, x, top, h);
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
      return this.framed(o.title, body, hits, w, x, top, h);
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
    return this.framed(o.title, body, hits, w, x, top, h);
  }

  private placeholder(): string {
    const o = this.overlay;
    if (o?.kind === "settings" && o.draft) return `Esc goes back to the name (${o.draft.name})`;
    if (o) return `Esc closes ${o.kind === "settings" ? "settings" : o.kind === "help" ? "the keys" : o.kind === "confirm" ? "this without changing anything" : "the list"}`;
    if (this.onNewRow) return "Name the new agent, e.g. repo-keeper";
    const a = this.agent;
    if (!a) return "";
    // On a question, the box takes your answer to it, and says so.
    const q = this.questionInFocus();
    const d = this.choosing;
    if (q && d) {
      const parts = questionParts(q);
      const p = parts[d.at];
      const n = p?.options?.length ?? 0;
      if (parts.length > 1) return `Your answer to Q${d.at + 1} of "${shortQuestion(q, 40)}"${n ? `, or press ${n === 1 ? "1" : `1–${n}`}` : ""}`;
      if (d.picks[0]?.length) return `Enter answers with ${d.picks[0].length === 1 ? "the option" : "the options"} you picked; or add a few words`;
      return `Your answer to "${shortQuestion(q, 40)}"${n ? `, or press ${n === 1 ? "1" : `1–${n}`} to ${p.single || n === 1 ? "choose" : "pick"}` : ""}`;
    }
    // Your message, always: an open question waits pinned above, until you go to it.
    const tab = this.open.length ? `  ·  Tab to answer ${this.open.length === 1 ? "its question" : `its ${this.open.length} questions`}` : "";
    if (a.status === "new") return `Tell ${a.name} what it's for…`;
    if (a.status === "stopped") return `Message ${a.name} (stopped; it reads this when started)${tab}`;
    return `Message ${a.name}${tab || "  ·  drag files here to attach"}`;
  }

  private renderChips(w: number, row: number, x0: number): string {
    let s = "  ";
    let x = x0 + 2;
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
    // Answering a question: a yellow ? where the › is, so it's clear the box is taking an answer, not a message.
    const prompt = !active ? muted("›") : this.asking ? yellow(bold("?")) : accent("›");
    // The / menu sits under what you're typing, inside the box.
    const lines = [...body.map((l, n) => `${n === 0 ? prompt : " "} ${l}`), ...(typed?.menu.length ? ["", ...typed.menu.map((l) => `  ${l}`)] : [])];
    // A long message scrolls inside the box: say how much of it is out of view, above and below.
    const up = typed?.above ? muted(`↑ ${typed.above} more`) : "";
    const down = typed?.below ? muted(`↓ ${typed.below} more`) : "";
    // Where the text sits in the box (rows from the box's top, the column it starts at), for the mouse.
    const at = (textTop: number, textX: number) => Object.assign(this.box, { textTop, textX, textRows: body.length, menuRows: typed?.menu.length ?? 0, textW: inner });
    if (!roomy) {
      at(up ? 1 : 0, 3);
      return [...(up ? [`  ${up}`] : []), ...lines, ...(down ? [`  ${down}`] : [])].map((l) => fit(" " + l, w));
    }
    at(1, 4);
    // Like Grok CLI: a filled block on a tint, no border. Without tints, a quiet rounded border.
    if (hasTints()) return [element(up && `    ${up}`, w), ...lines.map((l) => element(`  ${l}`, w)), element(down && `    ${down}`, w)];
    const c = active && this.typing() ? accent : faint;
    const edge = (l: string, r: string, note: string) => (note ? c(l + "───") + ` ${note} ` + c("─".repeat(Math.max(0, w - 7 - visibleWidth(note))) + r) : c(l + "─".repeat(Math.max(0, w - 2)) + r));
    return [edge("╭", "╮", up), ...lines.map((l) => c("│") + " " + fit(l, w - 4) + " " + c("│")), edge("╰", "╯", down)];
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
    const q = !this.onNewRow ? this.questionInFocus() : undefined;
    const o = this.overlay;
    if (o?.kind === "settings") hints = o.editing ? [keyHint("enter", "save"), keyHint("esc", "cancel")] : [keyHint("↑↓", "move"), keyHint("enter", o.draft && o.sel === "create" ? "create" : "change"), keyHint("esc", o.draft ? "back to the name" : "close")];
    else if (o?.kind === "help") hints = [keyHint("any key", "close")];
    else if (o?.kind === "confirm") hints = [keyHint("←→", "choose"), keyHint("enter", "confirm"), keyHint("esc", "cancel")];
    else if (o) hints = [keyHint("↑↓", "move"), keyHint("enter", "choose"), keyHint("esc", o.kind === "pick" && o.back ? "back" : "close")];
    else if (this.onNewRow) hints = [keyHint("enter", "create"), keyHint("↑↓", "agents"), keyHint("?", "keys")];
    else if (this.input.selection()) hints = [keyHint("^C", "copy"), keyHint("^X", "cut"), keyHint("type", "replace"), keyHint("esc", "deselect")];
    else if (q) {
      // On a question: its keys, how to get to the others, and the way back to your message.
      const parts = questionParts(q);
      const at = this.choosing?.at ?? 0;
      const n = parts[at]?.options?.length ?? 0;
      const last = at === parts.length - 1;
      hints = [
        n && !this.typing() ? keyHint(n === 1 ? "1" : `1–${n}`, parts[at].single ? "choose" : "pick") : "",
        keyHint("enter", parts.length > 1 ? (last ? "send answers" : "next") : "answer"),
        this.open.length > 1 ? keyHint("↑↓", "question") : "",
        // Tab past the last question is your message again, as Esc is: said once.
        (parts.length > 1 && !last) || this.open.at(-1) !== q ? keyHint("tab", parts.length > 1 && !last ? "next" : "next question") : "",
        keyHint("esc", "back to message"),
      ].filter(Boolean);
    } else if (this.typing() || this.pending.length) hints = [keyHint("enter", "send"), keyHint("⌥/⇧ enter", "new line"), keyHint("esc", "clear")];
    else hints = [this.open.length ? keyHint("tab", this.open.length === 1 ? "answer question" : `answer ${this.open.length} questions`) : "", keyHint("↑↓", "agents"), keyHint("→", "settings"), keyHint("⇧↑↓", "scroll"), this.targets().length ? keyHint("^L", "links") : "", keyHint("?", "keys")].filter(Boolean);
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

/**
 * The screen library selects whole screen rows, straight across both panes. Narrow what it highlights
 * and copies to the pane the selection started in, and to that pane's text (App.selectionArea).
 * The app draws exactly one screen, so the library's rows are screen rows.
 */
function keepSelectionInPane(tui: TuiAltScreen, app: App): void {
  type Point = { row: number; col: number; boundary?: boolean };
  const t = tui as any;
  const bounds: () => { start: Point; end: Point } | undefined = t.getSelectionBounds.bind(tui);
  const columns = t.getSelectionColumns.bind(tui);
  let area: ReturnType<App["selectionArea"]> = null;
  t.getSelectionBounds = () => {
    const b = bounds();
    const anchor: Point | undefined = t.selectionAnchor;
    area = b && anchor ? app.selectionArea(anchor.col, anchor.row) : null;
    if (!b || !area) return b;
    let { start, end } = b;
    if (start.row < area.top) start = { ...start, row: area.top, col: area.cols(area.top)[0] };
    if (end.row > area.bottom) end = { ...end, row: area.bottom, col: area.cols(area.bottom)[1], boundary: true };
    return start.row > end.row ? undefined : { start, end };
  };
  t.getSelectionColumns = (line: string, row: number, sel: unknown, min = 0, max = visibleWidth(line)) => {
    if (!area) return columns(line, row, sel, min, max);
    const [x0, x1] = area.cols(row);
    return columns(line, row, sel, Math.max(min, x0), Math.min(max, x1));
  };
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
  /** How text is put on the system clipboard (tests replace this). */
  clipboard?: (text: string) => Promise<boolean> | boolean;
}

export async function runApp(o: AppOptions = {}): Promise<{ app: App; tui: TuiAltScreen; stop: () => void }> {
  const connectFn = o.reconnect ?? ensureDaemon;
  const c = o.client ?? (await connectFn());
  const term = o.terminal ?? new ProcessTerminal();
  // A mouse report or key split across reads reaches the screen whole, never as typed text (see input.ts).
  const start = term.start.bind(term);
  term.start = (onInput, onResize) => start(wholeSequences(onInput), onResize);
  const opener = o.opener ?? openTarget;
  // The screen library pages, jumps and searches its own viewport (PgUp/PgDn, Home/End, Ctrl+↑↓,
  // Ctrl+Shift+F), but this app draws one screen and scrolls the conversation itself: hand those keys to
  // the app, so Home and End move the cursor in the message box.
  const kb = getKeybindings();
  const off = ["pageUp", "pageDown", "top", "bottom", "previousPrompt", "nextPrompt", "search"].map((k) => [`tui.altScreen.${k}`, []]);
  // The message box's editing keys, as in a Mac text box too: Ctrl+Z undoes, and Cmd with ← → Backspace
  // (from terminals that report Cmd) goes to or deletes to the line's ends.
  const editing = {
    "tui.editor.undo": ["ctrl+-", "ctrl+z", "super+z"],
    "tui.editor.cursorLineStart": ["home", "ctrl+home", "ctrl+a", "super+left"],
    "tui.editor.cursorLineEnd": ["end", "ctrl+end", "ctrl+e", "super+right"],
    "tui.editor.deleteToLineStart": ["ctrl+u", "super+backspace"],
  };
  kb.setUserBindings({ ...kb.getUserBindings(), ...Object.fromEntries(off), ...editing } as any);
  const tui = new TuiAltScreen(term, false, undefined, { openUrl: (url) => app.openLink(url), copyOnSelect: true, copySelection: async (text) => app.clipboard(text), mouse: o.mouse ?? !o.terminal });
  const timers: NodeJS.Timeout[] = [];
  let frameTimer: NodeJS.Timeout | undefined;
  let quitting = false;
  const app = new App(c, tui, term, () => {
    quitting = true;
    for (const t of timers) clearInterval(t);
    clearTimeout(frameTimer);
    (o.onQuit ?? (() => process.exit(0)))();
  }, opener);
  if (o.clipboard) app.clipboard = o.clipboard;
  keepSelectionInPane(tui, app);
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
      else if (e?.event === "notice") void app.showUpdateNotice();
      else void app.refresh();
    });
    try {
      app.setLive(await client.call("live"));
    } catch {}
    await app.refresh();
    // Back after an update, or opened since: "Updated to 0.7.9", once.
    void app.showUpdateNotice();
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
  // Spinners and state glyphs move on their own beat: each frame is drawn just after it begins, so none is
  // held longer than the others. With nothing moving there is no fast timer, only a look once a second.
  const frame = () => {
    const ms = app.frameMs();
    frameTimer = setTimeout(() => {
      if (quitting) return;
      if (ms) tui.requestRender();
      frame();
    }, ms ? ms - (Date.now() % ms) + 5 : 1000);
  };
  frame();
  timers.push(setInterval(() => void app.refresh(), 15_000));
  return { app, tui, stop: () => app.quit() };
}
