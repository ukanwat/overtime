import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../paths.js";
import { readJson } from "../fsutil.js";

/**
 * What an agent did, read back from Overtime's own record of each of its turns (runs/<id>.jsonl): what
 * it was told, the steps it took (with the command, file or message of each) and what it said. Used by
 * the reflect pass, which reads every turn once, oldest first, and by a helper started with_context.
 * The agent's main turns and its chats with the person both count: corrections happen in either.
 */

/** One turn as read back from its run log. */
export interface TurnRecord {
  id: string;
  /** When it started (from its id, UTC). */
  at: Date;
  told: string;
  steps: string[];
  said: string;
  /** "learned:" lines from helpers' results in what it was told, each with the helper it came from. */
  learned: { helper: string; text: string }[];
  /** It ended (or failed); a run still being written has neither yet. */
  ended: boolean;
  /** When its log was last written. */
  mtimeMs: number;
}

const KINDS = ["main_", "chat_"];
/** Per turn, what is kept of it in a digest: enough for a person's correction or a helper's result, never a whole transcript. */
const TOLD_MAX = 6_000;
const SAID_MAX = 3_000;
const STEPS_MAX = 60;

/** When each run log began, to the millisecond (its first record's time): run ids only go to the second. */
const began = new Map<string, string>();

async function beganAt(file: string, id: string): Promise<string> {
  const hit = began.get(file);
  if (hit) return hit;
  let t = "";
  try {
    const fh = await open(file, "r");
    try {
      const b = Buffer.alloc(80);
      const { bytesRead } = await fh.read(b, 0, 80, 0);
      t = /^\{"t":"([^"]+)"/.exec(b.toString("utf8", 0, bytesRead))?.[1] ?? "";
    } finally {
      await fh.close();
    }
  } catch {}
  // Without a first record yet, its id's second stands in (not kept: the record is coming).
  if (!t) return new Date(runTime(id)).toISOString();
  began.set(file, t);
  return t;
}

/** When a run started, from its id (UTC to the second), in ms. */
export function runTime(id: string): number {
  const m = /_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/.exec(id);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
}

/** The ids of an agent's main turns and chats, in the order they began. */
export async function runIds(agentName: string): Promise<string[]> {
  const dir = join(paths.meta(agentName), "runs");
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl") && KINDS.some((k) => f.startsWith(k)));
  } catch {
    return [];
  }
  const keyed = await Promise.all(files.map(async (f) => ({ id: f.slice(0, -".jsonl".length), t: await beganAt(join(dir, f), f) })));
  return keyed.sort((a, b) => a.t.localeCompare(b.t) || a.id.localeCompare(b.id)).map((k) => k.id);
}

/** The runs after the cursor (a run id; null: all of them), in order. A cursor whose log is gone (old logs are removed) goes by its time. */
export async function runsAfter(agentName: string, cursor: string | null): Promise<string[]> {
  const ids = await runIds(agentName);
  if (!cursor) return ids;
  const at = ids.indexOf(cursor);
  if (at >= 0) return ids.slice(at + 1);
  return ids.filter((id) => runTime(id) > runTime(cursor));
}

/** A finished run's log never changes again: each is read once (keyed by size and time, so one still being written is read anew). */
const cache = new Map<string, { size: number; mtimeMs: number; turn: TurnRecord | null }>();

export async function readTurn(agentName: string, id: string): Promise<TurnRecord | null> {
  const file = join(paths.meta(agentName), "runs", `${id}.jsonl`);
  const st = await stat(file).catch(() => null);
  if (!st) return null;
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.turn;
  const turn = parseRun(id, await readFile(file, "utf8").catch(() => ""), st.mtimeMs);
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, turn });
  return turn;
}

/** A tool call as it streamed in: its first update names it, later ones bring its input, and the last its outcome. */
interface Call {
  name: string;
  title: string;
  kind: string;
  input: Record<string, unknown> | null;
  status: string;
  output: string;
  paths: string[];
}

export function parseRun(id: string, text: string, mtimeMs = 0): TurnRecord | null {
  let told = "";
  let said = "";
  let afterTool = false;
  let ended = false;
  const calls = new Map<string, Call>();
  const events: any[] = [];
  for (const line of text.split("\n")) {
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  // Logs written before appends were kept in order can have records out of place: each record's time
  // was taken when it was made, so sorting by it (stable for equal times) puts them back.
  events.sort((a, b) => String(a?.t ?? "").localeCompare(String(b?.t ?? "")));
  for (const e of events) {
    if (e?.event === "prompt" && typeof e.data?.text === "string") told = turnPart(e.data.text);
    else if (e?.event === "end" || e?.event === "error") ended = true;
    else if (e?.event === "update") {
      const u = e.data;
      if (u?.sessionUpdate === "agent_message_chunk" && typeof u.content?.text === "string") {
        // Text from separate messages (with tool calls between) becomes separate paragraphs, as the reply does.
        if (afterTool && said && !/\s$/.test(said)) said += "\n\n";
        afterTool = false;
        said += u.content.text;
      } else if ((u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") && typeof u.toolCallId === "string") {
        if (u.sessionUpdate === "tool_call") afterTool = true;
        const c = calls.get(u.toolCallId) ?? { name: "", title: "", kind: "", input: null, status: "", output: "", paths: [] };
        const tool = u._meta?.claudeCode?.toolName;
        if (typeof tool === "string" && !c.name) c.name = tool;
        if (typeof u.title === "string" && u.title && (!c.title || c.title === c.name)) c.title = u.title;
        if (typeof u.kind === "string" && u.kind) c.kind = u.kind;
        // The input streams in: the last one seen is the whole of it.
        if (u.rawInput && typeof u.rawInput === "object" && Object.keys(u.rawInput).length) c.input = u.rawInput;
        if (Array.isArray(u.locations)) for (const l of u.locations) if (typeof l?.path === "string" && !c.paths.includes(l.path)) c.paths.push(l.path);
        if (typeof u.status === "string" && u.status) c.status = u.status;
        if (u.status === "failed") c.output = outputText(u);
        calls.set(u.toolCallId, c);
      }
    }
  }
  const steps = [...calls.values()].map(describeCall).filter((s): s is string => !!s);
  if (!told && !said.trim() && !steps.length) return null;
  const at = new Date(runTime(id) || mtimeMs);
  return { id, at, told, steps, said: said.trim(), learned: learnedLines(told), ended, mtimeMs };
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

function outputText(u: any): string {
  const parts: string[] = [];
  for (const c of Array.isArray(u.content) ? u.content : []) {
    const t = c?.content?.text ?? c?.text;
    if (typeof t === "string") parts.push(t);
  }
  if (!parts.length && u.rawOutput != null) parts.push(typeof u.rawOutput === "string" ? u.rawOutput : JSON.stringify(u.rawOutput));
  return parts.join(" ").replace(/```\w*/g, "");
}

/** One line per step: the tool and what it was given (the command, the file, the message), and how a failure read. */
function describeCall(c: Call): string | null {
  const name = (c.name || c.title || c.kind || "tool").replace(/^mcp__overtime__/, "").replace(/^mcp__([^_]+)__/, "$1: ");
  const i = (c.input ?? {}) as Record<string, any>;
  const str = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) ? v.join(" ") : v == null ? "" : JSON.stringify(v));
  const file = str(i.file_path ?? i.path ?? i.notebook_path ?? c.paths[0] ?? "");
  let what: string;
  if (i.command != null || i.cmd != null) what = `${c.name ? name : "Run"}: ${clip(str(i.command ?? i.cmd).replace(/^(?:bash|sh|zsh) -l?c /, ""), 200)}`;
  else if (name === "send") what = `send${i.to ? ` to ${i.to}` : ""}: ${clip(str(i.text ?? i.status ?? i.title ?? ""), 500)}${i.status && !i.text ? " (status)" : ""}`;
  else if (name === "message") what = `message to ${str(i.to)}: ${clip(str(i.text), 500)}`;
  else if (name === "ask") what = `ask: ${clip(str(i.question), 300)}`;
  else if (name === "spawn") what = `spawn: ${clip(str(i.task), 300)}`;
  else if (name === "tell") what = `tell ${str(i.id)}: ${clip(str(i.text ?? i.note), 300)}`;
  else if (name === "wake") what = `wake${i.in ? ` in ${i.in}` : i.at ? ` at ${i.at}` : ""}${i.every ? ` every ${i.every}` : ""}${i.watch ? ` watch \`${clip(str(i.watch), 150)}\`` : ""}: ${clip(str(i.reason), 150)}`;
  else if (name === "skill") what = `skill ${str(i.name)}`;
  else if (/^(Edit|MultiEdit)$/.test(name) || (c.kind === "edit" && typeof i.new_string === "string")) what = `${name} ${file}${typeof i.new_string === "string" ? `: ${clip(i.new_string, 150)}` : ""}`;
  else if (name === "Write" || (c.kind === "edit" && typeof i.content === "string")) what = `Write ${file} (${str(i.content).split("\n").length} lines)`;
  else if (file && /^(Read|NotebookEdit|LS)$/.test(name)) what = `${name} ${file}`;
  else if (i.pattern != null) what = `${name} ${clip(str(i.pattern), 100)}${i.path ? ` in ${str(i.path)}` : ""}`;
  else if (i.url != null) what = `${name} ${clip(str(i.url), 200)}`;
  else if (i.query != null) what = `${name}: ${clip(str(i.query), 200)}`;
  else if (file) what = `${name} ${file}`;
  else if (c.input) what = `${name}: ${clip(JSON.stringify(c.input), 200)}`;
  else what = clip(c.title || name, 160);
  // Failures are the lessons: say so, with how the error read.
  return c.status === "failed" ? `${what} (failed${c.output ? `: ${clip(c.output, 200)}` : ""})` : what;
}

/** Overtime's lines at the top of every turn that say nothing about the turn itself (the time, spend, running things, skill names). */
const HEADER_NOISE = /^(Time now: |Spent today: |Used today: |Nothing spent yet today|Helpers still running: |Still running in the background|Your skills \(load with skill\): |Your workspace \(where the work lives\): |Read-only for you )/;
/** Sections of a turn's text that repeat what it already had (its files, the conversation, the instructions): one line instead. */
const SECTION_NOTE: [RegExp, string | null][] = [
  [/^Your recent conversation with the person/, null],
  [/^Overtime's working instructions for you have been updated/, null],
  [/^AGENT\.md changed since your last turn/, "(AGENT.md had changed since its last turn.)"],
  [/^INDEX\.md changed since your last turn/, "(INDEX.md had changed since its last turn.)"],
  [/^memory\/MEMORY\.md (\(your memory index|was emptied)/, "(memory/MEMORY.md had changed since its last turn.)"],
];
/** Paragraphs Overtime adds to every turn: the standing reminders, not anything that happened. */
const PARAGRAPH_NOISE = /^(Reply with send to new messages from the person|This is your first conversation\. You don't have an identity yet|Note: this is a fresh session\. |\(MEMORY\.md is \d+ lines, over the )/;

/** What a turn was told, without Overtime's standing text: the opening of a fresh session and the per-turn boilerplate. */
export function turnPart(prompt: string): string {
  // The turn's own part starts at its header; a fresh session's opening comes before it.
  const starts = [...prompt.matchAll(/(?:^|\n)Time now: [^\n]*\nWhy you are awake: /g)];
  let t = starts.length ? prompt.slice(starts.at(-1)!.index! + (prompt[starts.at(-1)!.index!] === "\n" ? 1 : 0)) : prompt.slice(prompt.lastIndexOf("\n---\n") + 1);
  const cut = t.indexOf("\n\n");
  const head = (cut < 0 ? t : t.slice(0, cut)).split("\n").filter((l) => !HEADER_NOISE.test(l));
  const sections = (cut < 0 ? "" : t.slice(cut + 2)).split("\n\n---\n\n").flatMap((s) => {
    const body = s.trim();
    const hit = SECTION_NOTE.find(([re]) => re.test(body));
    if (!hit) return [body];
    return hit[1] ? [hit[1]] : [];
  });
  return [head.join("\n"), ...sections]
    .join("\n\n")
    .split("\n\n")
    .filter((p) => !PARAGRAPH_NOISE.test(p.trim()))
    .join("\n\n")
    .trim();
}

/** A helper's result as Overtime hands it to the agent: its heading, its id, the result, then where its work is. */
const HELPER_RESULT = /^(?:\d+\. Helper result|- helper) — [^\n]*\n(?:Finished|Cancelled|Stopped|Failed) \((helper_\d{14}_[0-9a-f]+)\): [^\n]*\n/gm;
/** "learned: nothing new" and the like: no lesson. */
const NOTHING = /^[("'`*\s]*(nothing( new| else| to (add|report|note)| of note)?|none|no new( lessons?| facts?)?|no lessons?|n\/a)\b[)"'`*.!]*(\s*$|\s+(this time|here|today)\b|\s*[—–:,(-])|^-+$/i;

/**
 * The "learned:" lines in the helpers' results a turn was handed, each with the helper it came from:
 * one per line, or a "learned:" heading with bullet lines under it. Only from a result as Overtime
 * delivers it (anything else in the turn, a message from another agent say, isn't a helper's lesson);
 * the caller keeps only helpers the agent really started. "Nothing new" and the like are left out.
 */
export function learnedLines(text: string): { helper: string; text: string }[] {
  const out: { helper: string; text: string }[] = [];
  const results = [...text.matchAll(HELPER_RESULT)];
  for (const [i, m] of results.entries()) {
    const start = m.index! + m[0].length;
    // To where Overtime says where its work is, or the next helper's result, whichever comes first.
    const next = results[i + 1]?.index ?? text.length;
    const where = text.indexOf("\n\nIts work is in ", start);
    const lines = text.slice(start, where >= 0 && where < next ? where : next).split("\n");
    for (let n = 0; n < lines.length; n++) {
      const l = /^\s*(?:[-*]\s*)?\**learned\**\s*:\**\s*(.*)$/i.exec(lines[n]);
      if (!l) continue;
      const items = l[1].trim() ? [l[1].trim()] : [];
      // A heading: the bullet lines right under it are the items.
      if (!items.length) for (let k = n + 1; k < lines.length && /^\s*[-*]\s+\S/.test(lines[k]); k++) items.push(lines[k].replace(/^\s*[-*]\s+/, "").trim());
      for (const item of items) if (!NOTHING.test(item)) out.push({ helper: m[1], text: item });
    }
  }
  return out;
}

/** A turn as the reflect pass (or a helper with context) reads it. */
export function renderTurn(t: TurnRecord, opts: { ids?: boolean } = {}): string {
  const d = t.at.toISOString();
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);
  const steps = t.steps.length > STEPS_MAX ? [...t.steps.slice(0, STEPS_MAX), `… and ${t.steps.length - STEPS_MAX} more steps`] : t.steps;
  return [
    `## ${t.id.startsWith("chat_") ? "Chat with the person" : "Turn"} at ${d.slice(0, 10)} ${d.slice(11, 16)} UTC${opts.ids ? ` (run ${t.id})` : ""}`,
    t.told ? `It was told:\n${cut(t.told, TOLD_MAX)}` : "",
    steps.length ? `It did:\n${steps.map((s) => `- ${s}`).join("\n")}` : "",
    t.said ? `It said:\n${cut(t.said, SAID_MAX)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A run that hasn't ended and was written to lately may still be going: not read until it's done. */
const STILL_GOING_MS = 3600_000;

/**
 * The turns after `cursor` (a run id; null: from the start), oldest first, until about maxChars of
 * digest. Always at least one turn when there is one. It stops before a run that may still be going, so
 * nothing is passed over. `last` is the id to move the cursor to once these are reflected.
 */
export async function unreadChunk(agentName: string, cursor: string | null, maxChars: number, now = Date.now()): Promise<{ text: string; learned: string[]; turns: TurnRecord[]; last: string | null; left: number }> {
  const ids = await runsAfter(agentName, cursor);
  const parts: string[] = [];
  const learned: string[] = [];
  // Only lessons from helpers this agent really started.
  const helpers = new Set(((await readJson<{ id: string }[]>(join(paths.meta(agentName), "helpers.json"), [])) ?? []).map((h) => h.id));
  const turns: TurnRecord[] = [];
  let size = 0;
  let last: string | null = null;
  let n = 0;
  for (; n < ids.length; n++) {
    const t = await readTurn(agentName, ids[n]);
    if (t && !t.ended && now - t.mtimeMs < STILL_GOING_MS) break;
    if (!t) {
      last = ids[n]; // a log with nothing in it: passed over, never waited on
      continue;
    }
    const text = renderTurn(t, { ids: true });
    if (size + text.length > maxChars && turns.length) break;
    parts.push(text);
    learned.push(...t.learned.filter((l) => helpers.has(l.helper)).map((l) => `- ${l.text} (from ${l.helper}, run ${t.id})`));
    turns.push(t);
    size += text.length;
    last = t.id;
  }
  return { text: parts.join("\n\n"), learned, turns, last, left: ids.length - n };
}

/** How much hasn't been reflected yet: turns and characters of digest, and when the newest of them started. */
export async function unreadVolume(agentName: string, cursor: string | null, now = Date.now()): Promise<{ turns: number; chars: number; newest: Date | null }> {
  let turns = 0;
  let chars = 0;
  let newest: Date | null = null;
  for (const id of await runsAfter(agentName, cursor)) {
    const t = await readTurn(agentName, id);
    if (!t) continue;
    if (!t.ended && now - t.mtimeMs < STILL_GOING_MS) break;
    turns++;
    chars += renderTurn(t, { ids: true }).length;
    newest = t.at;
  }
  return { turns, chars, newest };
}

/** The newest turns, newest kept when it's long, in the order they happened: what an agent has been doing lately. */
export async function recentTurns(agentName: string, maxChars: number): Promise<string> {
  const ids = (await runIds(agentName)).filter((id) => id.startsWith("main_")).reverse();
  const out: string[] = [];
  let size = 0;
  for (const id of ids.slice(0, 30)) {
    const t = await readTurn(agentName, id);
    if (!t) continue;
    const text = renderTurn(t);
    if (size + text.length > maxChars && out.length) break;
    out.push(text);
    size += text.length;
  }
  return out.reverse().join("\n\n");
}
