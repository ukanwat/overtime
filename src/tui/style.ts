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
  /** The selected agent in the list: a little stronger than selectBg, leaning to the accent. */
  pickBg: string | null;
}

const noColor = () => "NO_COLOR" in process.env && process.env.NO_COLOR !== "";
const FALLBACK: Palette = { text: null, muted: "2", faint: "2", accent: "36", yellow: "33", red: "31", panelBg: null, elementBg: null, selectBg: null, pickBg: null };
let pal: Palette = FALLBACK;
let scheme: "dark" | "light" | null = null;
/** The real colours behind the palette (true colour only), for the state glyph's gentle pulses. */
let tones: { bg: Rgb; text: Rgb; accent: Rgb; yellow: Rgb; red: Rgb } | null = null;

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
  tones = { bg, text, accent: dark ? hex("#5c9cf5") : hex("#2563c9"), yellow: dark ? hex("#e5c07b") : hex("#9a6a00"), red: dark ? hex("#e06c75") : hex("#c0392b") };
  pal = {
    text: null, // the terminal's own foreground stays the body colour
    muted: fg(mix(bg, text, 0.55)),
    faint: fg(mix(bg, text, 0.28)),
    accent: fg(tones.accent),
    yellow: fg(tones.yellow),
    red: fg(tones.red),
    panelBg: bgc(mix(bg, text, dark ? 0.07 : 0.05)),
    elementBg: bgc(mix(bg, text, dark ? 0.11 : 0.08)),
    selectBg: bgc(mix(bg, text, dark ? 0.16 : 0.12)),
    pickBg: bgc(mix(mix(bg, text, dark ? 0.12 : 0.08), tones.accent, dark ? 0.14 : 0.1)),
  };
}

/** For tests: back to the basic-colour palette. */
export function resetPalette(): void {
  pal = FALLBACK;
  tones = null;
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
export const picked = tint(() => pal.pickBg);

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

/** When something happens next, the way a person would say it: "in 20m", "at 14:05", "Tue 09:00", "23 Oct 09:00". */
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
  // A weekday only names a day in the coming week: a week or more out (today's weekday, say), the date does.
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(today).setHours(0, 0, 0, 0)) / 86400000);
  if (days < 7) return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
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
  limitResetsAt?: string | null;
  trouble?: { since: string; backend: string; signIn?: boolean } | null;
  offlineSince?: string | null;
  nextWake: string | null;
  pausedUntil: string | null;
  lastError: string | null;
  helpersRunning?: number;
  /** Open questions for the person. */
  waiting?: number;
}

/**
 * An agent's state, decided once for everything that shows it: the mark before its name and the word next to
 * the mark always agree, so each mark means one thing. In order, the first that holds:
 * - trouble (⊘): "retrying at …" after a failed turn, "can't reach …", "… isn't signed in" or "no internet"
 * - working (◐ turning): its turn or its helpers are running
 * - needs you (●): an open question, "· wakes …" if it also has a wake
 * - paused (◌), stopped (⊖), new (◦)
 * - asleep (○): "· wakes …"
 * `word` is the whole phrase for the state; `detail` is the rest, shown after a " · ".
 */
export function statusParts(a: StatusLike): { kind: StateKind; word: string; detail: string; color: (s: string) => string } {
  const wakes = a.nextWake ? `wakes ${when(a.nextWake).replace(/^at /, "")}` : "";
  // Can't reach its backend: it's waiting, not working, whatever is still running, and it says why.
  const busy = a.status === "working" || !!a.helpersRunning || !!a.trouble;
  if (a.status !== "stopped" && a.status !== "paused" && busy && (a.offlineSince || (a.trouble && a.status !== "working"))) {
    return { kind: "trouble", word: a.offlineSince ? "no internet" : a.trouble!.signIn ? `${a.trouble!.backend} isn't signed in` : `can't reach ${a.trouble!.backend}`, detail: "", color: red };
  }
  // Not working, paused, stopped or new: its own session is resting ("asleep", or "error" between retries).
  const resting = !["working", "paused", "stopped", "new"].includes(a.status);
  // Its own session is resting, but its helpers are working: the agent is busy, so say so.
  if (a.status === "working" || (resting && a.helpersRunning)) {
    return { kind: "working", word: "working", detail: a.helpersRunning ? `${a.helpersRunning} helper${a.helpersRunning === 1 ? "" : "s"}` : "", color: accent };
  }
  if (resting && a.lastError) return { kind: "trouble", word: a.nextWake ? `retrying ${when(a.nextWake)}` : "retrying", detail: "", color: red };
  if (a.waiting) return { kind: "needs", word: "needs you", detail: resting ? wakes : "", color: yellow };
  switch (a.status) {
    case "paused": {
      if (a.pauseReason === "limit") {
        // It tries again before the reset (the limit can lift early): say when it resets, if known.
        return { kind: "paused", word: "paused", detail: a.limitResetsAt ? `usage limit, resets ${when(a.limitResetsAt)}` : `usage limit, trying again ${when(a.pausedUntil)}`, color: muted };
      }
      const why = a.pauseReason === "budget" ? "budget used" : "paused";
      return { kind: "paused", word: "paused", detail: `${why}${a.pausedUntil ? `, back ${when(a.pausedUntil)}` : ""}`, color: muted };
    }
    case "stopped":
      return { kind: "stopped", word: "stopped", detail: "", color: gray };
    case "new":
      return { kind: "new", word: "new", detail: "waiting for its job", color: muted };
    default:
      return { kind: "asleep", word: "asleep", detail: wakes, color: gray };
  }
}

export type StateKind = "trouble" | "working" | "needs" | "paused" | "stopped" | "new" | "asleep";

/**
 * The circle before an agent's name: its state (statusParts) at a glance. All circles, so they read as one
 * set; the shape says the state, colour only helps:
 * - working: a half-filled circle turning, in the accent      - needs you: a full circle, pulsing yellow
 * - retrying or can't reach its backend: struck through, red
 * - asleep: an empty circle; paused: a dotted circle; stopped: a circled minus; new: a small circle (all still and dim)
 * SF Mono has only ●, ○ and ◦; Terminal.app draws the rest from Menlo, also one column wide.
 * `period` is how often it changes, in ms (null when it's still).
 */
export function stateGlyph(a: StatusLike, now = Date.now()): { glyph: string; period: number | null } {
  const p = statusParts(a);
  const still = !!process.env.OVERTIME_STILL;
  // A colour between the background and `to`, rising and falling once per `cycle` ms, in steps of `step` ms.
  const pulse = (to: Tone, lo: number, hi: number, cycle: number, step: number) => (still ? null : tone(to, lo + (hi - lo) * wave(now, cycle, step)));
  switch (p.kind) {
    case "working":
      // A quarter turn every 200 ms: a calm turn a little under once a second.
      return { glyph: accent(STATE_TURN[still ? 0 : Math.floor(now / 200) % STATE_TURN.length]), period: still ? null : 200 };
    case "needs": {
      const t = pulse("yellow", 0.45, 1, 1600, 100);
      return { glyph: (t ?? yellow)(STATE_ICONS.needs), period: t ? 100 : null };
    }
    case "trouble":
      return { glyph: red(STATE_ICONS.trouble), period: null };
    case "asleep":
      // Still: agents are asleep most of the time, and a list of them all breathing is distracting.
      return { glyph: muted(STATE_ICONS.asleep), period: null };
    case "stopped":
      return { glyph: faint(STATE_ICONS.stopped), period: null };
    default:
      return { glyph: muted(STATE_ICONS[p.kind]), period: null };
  }
}

/** The working circle's frames (cli-spinners' circleHalves), and the still circle for every other state. */
export const STATE_TURN = ["◐", "◓", "◑", "◒"];
export const STATE_ICONS = { needs: "●", trouble: "⊘", asleep: "○", paused: "◌", stopped: "⊖", new: "◦" } as const;

/** The state in a word or two, for the right of an agent's name in the list. */
export function stateWord(a: StatusLike): string {
  const p = statusParts(a);
  switch (p.kind) {
    case "working":
      return accent("working");
    case "needs":
      return yellow("needs you");
    case "trouble":
      return red(a.trouble?.signIn && !a.offlineSince && a.status !== "working" ? "not signed in" : a.lastError ? "retrying" : a.offlineSince ? "offline" : "can't reach");
    case "asleep":
      return muted(a.nextWake ? clock(a.nextWake) : "asleep");
    case "stopped":
      return faint("stopped");
    default:
      return muted(p.word);
  }
}

/** A short clock time: "6:53pm" today, "Sat" later this week, "24 Oct" a week or more away. */
export function clock(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (d.toDateString() !== new Date().toDateString()) {
    // As in when(): a weekday only names a day in the coming week.
    const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
    return days < 7 ? d.toLocaleDateString([], { weekday: "short" }) : d.toLocaleDateString([], { day: "numeric", month: "short" });
  }
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?([AaPp])\.?\s?[Mm]\.?$/, (_, x: string) => `${x.toLowerCase()}m`);
}

export type Tone = "text" | "accent" | "yellow" | "red";

/** Text in a colour `at` (0 to 1) of the way from the background to `to`; null without true colour, or with NO_COLOR. */
export function tone(to: Tone, at: number): ((s: string) => string) | null {
  if (!tones || noColor()) return null;
  const c = fg(mix(tones.bg, tones[to], at));
  return (s) => `\x1b[${c}m${s}\x1b[39m`;
}

/** 0 rising to 1 and back once every `cycle` ms, moving in steps of `step` ms; `shift` (0 to 1) starts it later. */
export function wave(now: number, cycle: number, step: number, shift = 0): number {
  const phase = ((Math.floor(now / step) * step) % cycle) / cycle - shift;
  return (1 - Math.cos(2 * Math.PI * phase)) / 2;
}

/** A braille spinner's frames: also the app's "loading" spinner, so everything that turns turns together. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** An agent's mark and state in a line, standing still (for printing once, as `overtime ls` does). */
export function statusLine(a: StatusLike): string {
  const p = statusParts(a);
  return stateGlyph(a, 0).glyph + " " + p.color(p.word) + (p.detail ? gray(` · ${p.detail}`) : "");
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
