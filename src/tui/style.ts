import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * The look of Overtime, shared by the full-screen app and the plain command line.
 * One accent colour, dim for everything secondary, colour only where it carries meaning
 * (green working, yellow needs you or paused, red failing). NO_COLOR keeps bold and dim but drops colour.
 */

const noColor = () => "NO_COLOR" in process.env && process.env.NO_COLOR !== "";
const sgr = (on: string, off: string, isColor = false) => (s: string) => (isColor && noColor() ? s : `\x1b[${on}m${s}\x1b[${off}m`);

export const bold = sgr("1", "22");
export const dim = sgr("2", "22");
export const italic = sgr("3", "23");
export const inverse = sgr("7", "27");
export const underline = sgr("4", "24");
export const accent = sgr("38;5;75", "39", true); // a calm blue
export const green = sgr("32", "39", true);
export const yellow = sgr("33", "39", true);
export const red = sgr("31", "39", true);
export const gray = sgr("90", "39", true);
/**
 * Whether the terminal is known to have a dark background (COLORFGBG, set by iTerm2, rxvt, Konsole...).
 * A soft row highlight only reads well on dark backgrounds, so it's used only when we know.
 */
const darkBackground = (() => {
  const bg = Number((process.env.COLORFGBG ?? "").split(";").pop());
  return Number.isFinite(bg) && process.env.COLORFGBG ? bg < 7 || bg === 8 : false;
})();

/** A selected row: a soft background on dark terminals; elsewhere the accent bar alone marks it. */
export const selectedBg = (s: string) => (noColor() || !darkBackground ? s : `\x1b[48;5;236m${s.replace(/\x1b\[0m/g, "\x1b[0m\x1b[48;5;236m").replace(/\x1b\[49m/g, "\x1b[48;5;236m")}\x1b[49m`);

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

export const rule = (w: number) => gray("─".repeat(Math.max(0, w)));

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
  nextWake: string | null;
  pausedUntil: string | null;
  lastError: string | null;
  helpersRunning?: number;
}

/** A short dot and phrase for an agent's state, e.g. "● working", "○ asleep · wakes at 14:05". */
export function statusParts(a: StatusLike): { dot: string; word: string; detail: string; color: (s: string) => string } {
  switch (a.status) {
    case "working":
      return { dot: "●", word: "working", detail: a.helpersRunning ? `${a.helpersRunning} helper${a.helpersRunning === 1 ? "" : "s"}` : "", color: green };
    case "paused": {
      const why = /budget/.test(a.activity) ? "budget used" : /limit/.test(a.activity) ? "usage limit" : "paused";
      return { dot: "◌", word: "paused", detail: `${why}${a.pausedUntil ? `, back ${when(a.pausedUntil)}` : ""}`, color: yellow };
    }
    case "stopped":
      return { dot: "■", word: "stopped", detail: "", color: gray };
    case "new":
      return { dot: "◇", word: "new", detail: "waiting for its job", color: accent };
    default:
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
  let m = String((e as any)?.message ?? e ?? "Something went wrong.");
  m = m.replace(/^(Error|RequestError|TypeError):\s*/i, "").split("\n")[0];
  if (/daemon disconnected|ECONNREFUSED|ENOENT.*sock|EPIPE/i.test(m)) return "Can't reach Overtime's background process. Reconnecting…";
  if (/didn't answer/.test(m)) return "Overtime's background process is busy and didn't answer. Try again in a moment.";
  return m;
}
