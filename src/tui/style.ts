import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DaemonTimeoutError, isDaemonGone } from "../daemon/client.js";

/**
 * The look of Overtime, shared by the full-screen app and the plain command line.
 *
 * Modelled on Grok CLI's look: a calm grey hierarchy, one blue accent, panels as a faint tint of the
 * background instead of boxes and borders. Every colour has one meaning:
 * - text: everything you read; muted: secondary (times, hints); faint: rules and quiet chrome
 * - accent: agents, links, the selection, things you can press; "working"
 * - yellow: needs you (an open question)       - red: something failed
 *
 * The app asks the terminal for its real colours, so tints are mixed from your actual background and
 * read right on dark and light themes alike. Without that (or without true colour) it falls back to the
 * terminal's own basic colours, using dim rather than "bright black", which some themes make invisible.
 * NO_COLOR keeps bold, dim and inverse but drops colour.
 */

type Rgb = { r: number; g: number; b: number };
interface Palette {
  text: string | null;
  muted: string;
  faint: string;
  accent: string;
  yellow: string;
  red: string;
  /** Background tints (true colour only): a panel behind your messages, and the composer. */
  panelBg: string | null;
  elementBg: string | null;
  selectBg: string | null;
}

const noColor = () => "NO_COLOR" in process.env && process.env.NO_COLOR !== "";
const FALLBACK: Palette = { text: null, muted: "2", faint: "2", accent: "36", yellow: "33", red: "31", panelBg: null, elementBg: null, selectBg: null };
let pal: Palette = FALLBACK;
let scheme: "dark" | "light" | null = null;

const fg = (c: Rgb) => `38;2;${c.r};${c.g};${c.b}`;
const bgc = (c: Rgb) => `48;2;${c.r};${c.g};${c.b}`;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => ({ r: Math.round(a.r + (b.r - a.r) * t), g: Math.round(a.g + (b.g - a.g) * t), b: Math.round(a.b + (b.b - a.b) * t) });
const lum = (c: Rgb) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
const hex = (h: string): Rgb => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });

/**
 * Use the terminal's real foreground and background (from an OSC 10/11 reply). With true colour, the
 * grey levels and tints are mixed from them; the accent is Grok's blue, darkened on light backgrounds.
 */
export function applyTerminalColors(colors: { foreground?: Rgb; background?: Rgb } | null | undefined, trueColor: boolean): void {
  const bg = colors?.background;
  if (!bg) return;
  const dark = lum(bg) < 0.5;
  scheme = dark ? "dark" : "light";
  if (!trueColor) return;
  const text = colors?.foreground ?? (dark ? hex("#e0e0e0") : hex("#1f1f1f"));
  pal = {
    text: null, // the terminal's own foreground stays the body colour
    muted: fg(mix(bg, text, 0.55)),
    faint: fg(mix(bg, text, 0.28)),
    accent: fg(dark ? hex("#5c9cf5") : hex("#2563c9")),
    yellow: fg(dark ? hex("#e5c07b") : hex("#9a6a00")),
    red: fg(dark ? hex("#e06c75") : hex("#c0392b")),
    panelBg: bgc(mix(bg, text, dark ? 0.07 : 0.05)),
    elementBg: bgc(mix(bg, text, dark ? 0.11 : 0.08)),
    selectBg: bgc(mix(bg, text, dark ? 0.16 : 0.12)),
  };
}

/** For tests: back to the basic-colour palette. */
export function resetPalette(): void {
  pal = FALLBACK;
  scheme = null;
}

export function colorScheme(): "dark" | "light" | null {
  return scheme;
}

const wrapFg = (code: () => string) => (s: string) => {
  if (noColor()) return s;
  const c = code();
  // A dim fallback is an attribute, not a colour: restore it after nested bold/dim resets.
  if (c === "2") return `\x1b[2m${s.replace(/\x1b\[22m/g, "\x1b[22m\x1b[2m")}\x1b[22m`;
  return `\x1b[${c}m${s.replace(/\x1b\[39m/g, `\x1b[39m\x1b[${c}m`)}\x1b[39m`;
};
const attr = (on: string, off: string) => (s: string) => `\x1b[${on}m${s}\x1b[${off}m`;

export const bold = attr("1", "22");
export const italic = attr("3", "23");
export const inverse = attr("7", "27");
export const underline = attr("4", "24");
export const dim = (s: string) => `\x1b[2m${s.replace(/\x1b\[22m/g, "\x1b[22m\x1b[2m")}\x1b[22m`;
export const muted = wrapFg(() => pal.muted);
export const faint = wrapFg(() => pal.faint);
export const accent = wrapFg(() => pal.accent);
export const yellow = wrapFg(() => pal.yellow);
export const red = wrapFg(() => pal.red);
/**
 * Text with a soft light sweeping across it, for "this is happening right now" (an agent working).
 * A small band of normal-brightness text moves across otherwise muted text, once every couple of
 * seconds: enough to see something is happening, never loud. Plain text without colour support.
 */
export function shimmer(text: string, now = Date.now()): string {
  // Plain characters only: an escape code split across the band would print as garbage.
  text = text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "");
  // Still frames for tests and anyone who wants no motion.
  if (process.env.OVERTIME_STILL) return muted(text);
  if (noColor() || !text) return text;
  const chars = Array.from(text);
  // One gentle pass every couple of seconds: a soft brightening (normal text over muted), no colour.
  const span = chars.length + 14;
  const pos = (Math.floor(now / 110) % span) - 4;
  const tone = (i: number) => (Math.abs(i - pos) <= 1 ? 1 : 0);
  let out = "";
  let run = "";
  let cur = tone(0);
  const flush = () => {
    if (run) out += cur === 2 ? accent(run) : cur === 1 ? run : muted(run);
    run = "";
  };
  chars.forEach((ch, i) => {
    const t = tone(i);
    if (t !== cur) {
      flush();
      cur = t;
    }
    run += ch;
  });
  flush();
  return out;
}

/** Plain text cut to w columns with an ellipsis, without adding any escape codes. */
export function cut(text: string, w: number): string {
  if (visibleWidth(text) <= w) return text;
  let out = "";
  for (const ch of Array.from(text)) {
    if (visibleWidth(out + ch) > w - 1) break;
    out += ch;
  }
  return out + "…";
}

/** Secondary text. */
export const gray = muted;
/** "Working" and success use the accent; there is no separate green. */
export const green = accent;

/** Whether background tints are available (true colour and a known background). */
export const hasTints = () => !noColor() && !!pal.panelBg;

/**
 * A line filled to width w on a background tint, which survives resets inside the text. Without tints
 * it is just the line, fitted.
 */
function tint(code: () => string | null) {
  return (s: string, w: number) => {
    const t = fit(s, w);
    const c = code();
    if (!c || noColor()) return t;
    return `\x1b[${c}m${t.replace(/\x1b\[0m/g, `\x1b[0m\x1b[${c}m`).replace(/\x1b\[49m/g, `\x1b[${c}m`)}\x1b[49m`;
  };
}
export const panel = tint(() => pal.panelBg);
export const element = tint(() => pal.elementBg);
export const selected = tint(() => pal.selectBg);

export const link = (target: string, label: string) => `\x1b]8;;${target}\x07${label}\x1b]8;;\x07`;

/** Exactly w columns: truncated with an ellipsis, or padded. */
export function fit(s: string, w: number): string {
  if (w <= 0) return "";
  const t = visibleWidth(s) > w ? truncateToWidth(s, w, "…") : s;
  return t + " ".repeat(Math.max(0, w - visibleWidth(t)));
}

/** Left text and right text on one line of width w; the left side gives way first. */
export function spread(left: string, right: string, w: number): string {
  const rw = visibleWidth(right);
  if (rw >= w) return fit(right, w);
  return fit(left, Math.max(0, w - rw - 1)) + " " + right;
}

export const rule = (w: number) => faint("─".repeat(Math.max(0, w)));

/** A box with a title in its top border. Body lines are fitted to the inside width. */
export function box(title: string, body: string[], w: number, opts: { focused?: boolean; footer?: string } = {}): string[] {
  const c = opts.focused === false ? gray : accent;
  const inner = Math.max(1, w - 4);
  const t = title ? ` ${bold(title)} ` : "";
  const top = c("╭─") + t + c("─".repeat(Math.max(0, w - 3 - visibleWidth(t))) + "╮");
  const foot = opts.footer ? ` ${opts.footer} ` : "";
  const bottom = c("╰" + "─".repeat(Math.max(0, w - 3 - visibleWidth(foot)))) + foot + c("─╯");
  return [top, ...body.map((l) => c("│") + " " + fit(l, inner) + " " + c("│")), bottom];
}

// ---------- time ----------

export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  if (m < 1) return "now";
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  if (m < 7 * 1440) return `${Math.round(m / 1440)}d`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** When something happens next, the way a person would say it: "in 20m", "at 14:05", "Tue 09:00". */
export function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const m = (d.getTime() - Date.now()) / 60000;
  if (m <= 1) return "now";
  if (m < 60) return `in ${Math.round(m)}m`;
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `at ${time}`;
  const tomorrow = new Date(today.getTime() + 86400000);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

export function stamp(iso: string): string {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return today ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

// ---------- agent status, said the same way everywhere ----------

export interface StatusLike {
  status: string;
  activity: string;
  pauseReason?: "budget" | "limit" | null;
  nextWake: string | null;
  pausedUntil: string | null;
  lastError: string | null;
  helpersRunning?: number;
}

/** A short dot and phrase for an agent's state, e.g. "● working", "○ asleep · wakes at 14:05". */
export function statusParts(a: StatusLike): { dot: string; word: string; detail: string; color: (s: string) => string } {
  switch (a.status) {
    case "working":
      return { dot: "●", word: "working", detail: a.helpersRunning ? `${a.helpersRunning} helper${a.helpersRunning === 1 ? "" : "s"}` : "", color: accent };
    case "paused": {
      const why = a.pauseReason === "budget" ? "budget used" : a.pauseReason === "limit" ? "usage limit" : "paused";
      return { dot: "◌", word: "paused", detail: `${why}${a.pausedUntil ? `, back ${when(a.pausedUntil)}` : ""}`, color: muted };
    }
    case "stopped":
      return { dot: "■", word: "stopped", detail: "", color: gray };
    case "new":
      return { dot: "◇", word: "new", detail: "waiting for its job", color: muted };
    default:
      // Its own session is resting, but its helpers are working: the agent is busy, so say so.
      if (a.helpersRunning) return { dot: "●", word: "working", detail: `${a.helpersRunning} helper${a.helpersRunning === 1 ? "" : "s"}`, color: accent };
      if (a.lastError) return { dot: "○", word: "retrying", detail: a.nextWake ? when(a.nextWake) : "", color: red };
      return { dot: "○", word: "asleep", detail: a.nextWake ? `wakes ${when(a.nextWake).replace(/^at /, "")}` : "", color: gray };
  }
}

export function statusLine(a: StatusLike): string {
  const p = statusParts(a);
  return p.color(`${p.dot} ${p.word}`) + (p.detail ? gray(` · ${p.detail}`) : "");
}

export function money(a: { costReported: boolean; spentUsd: number; budgetUsd: number; tokensToday: number }): string {
  if (a.costReported) return `$${a.spentUsd.toFixed(2)} of $${a.budgetUsd % 1 ? a.budgetUsd.toFixed(2) : a.budgetUsd} today`;
  return a.tokensToday ? `${Math.round(a.tokensToday / 1000)}k tokens today` : "nothing spent today";
}

// ---------- safety ----------

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

/** What opening a link should actually do, decided before anything is launched. */
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

export function openTarget(target: string): string | undefined {
  const plan = openPlan(target);
  if ("refuse" in plan) return plan.refuse;
  execFile(process.platform === "darwin" ? "open" : "xdg-open", plan.args, () => {});
  return plan.note;
}

/** Errors as a person should read them: no "Error:" prefixes, no stack, our own words for lost connections. */
export function friendly(e: unknown): string {
  if (isDaemonGone(e)) return "Can't reach Overtime's background process. Reconnecting…";
  if (e instanceof DaemonTimeoutError) return "Overtime's background process is busy and didn't answer. Try again in a moment.";
  // The message itself, first line only (no stack); errors from the daemon arrive as plain messages.
  return String((e as any)?.message ?? e ?? "Something went wrong.").split("\n")[0];
}
