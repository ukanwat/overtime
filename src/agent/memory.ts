import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFrontMatter, stringifyFrontMatter } from "./frontmatter.js";

/**
 * Overtime's own memory for an agent, the same on every backend: memory/ in its folder. MEMORY.md is a
 * short index, one line per memory that carries the rule or fact itself (`- [Title](file.md) — the rule`),
 * so the agent has it without opening anything. Each memory is a small file with a header (type, source,
 * date, last-verified) and the why and examples. The index is shown in every fresh session's opening;
 * the files are read when needed. How-tos stay in skills/.
 */
export const MEMORY_DIR = "memory";
export const MEMORY_INDEX = "MEMORY.md";
/** Above this many lines the index stops being a quick read: the agent is told to consolidate it. */
export const MEMORY_CAP_LINES = 150;

export function memoryIndexPath(agentDir: string): string {
  return join(agentDir, MEMORY_DIR, MEMORY_INDEX);
}

/** MEMORY.md as it is now, or "" when there's none yet. */
export async function readMemoryIndex(agentDir: string): Promise<string> {
  return readFile(memoryIndexPath(agentDir), "utf8").catch(() => "");
}

/** The index as an agent is shown it: all of it, never cut (past the cap it is told to consolidate: memoryOverCap). */
export function memoryText(index: string): string {
  return index.trim();
}

/**
 * Past the cap, a note to consolidate the index. It goes after the person's request in a turn (and in
 * a reflect pass), so it never comes ahead of the work it was woken for. "" under the cap.
 */
export function memoryOverCap(index: string): string {
  const lines = index.trim() ? index.trim().split("\n").length : 0;
  return lines > MEMORY_CAP_LINES ? `\n\n(MEMORY.md is ${lines} lines, over the ${MEMORY_CAP_LINES}-line cap. Before this turn ends, merge overlapping memories and delete stale ones until it is under the cap.)` : "";
}

/** The section of a fresh session's opening that shows the index. */
export function memoryBlock(agentDir: string, index: string): string {
  const where = join(agentDir, MEMORY_DIR);
  if (!index.trim()) return `# memory/MEMORY.md (what you've learned)\n\n(No memories yet. Save what you'll need again in ${where}/: one small file per memory, and one line for it in MEMORY.md.)`;
  return `# memory/MEMORY.md (what you've learned; the files are in ${where}/)\n\n${memoryText(index)}`;
}

// ---------- moving Claude's own memories over ----------

/** Where Claude Code kept its auto-memory for sessions run in this folder (every non-alphanumeric character becomes "-"). */
export function claudeMemoryDir(cwd: string): string {
  const root = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(root, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
}

const TYPES: Record<string, string> = { user: "person", person: "person", feedback: "feedback", project: "project", reference: "reference" };

/**
 * A Claude memory file with Overtime's header added (its own fields kept), so it reads like any other
 * memory. Its source: the person for what they said (Claude's user and feedback memories in the agent's
 * own sessions), otherwise observed. A helper's are all observed: its feedback memories are often its own
 * conclusions, not the person's words.
 */
function withHeader(text: string, modified: Date, helper = false): string {
  const { data, body } = parseFrontMatter(text);
  const meta = (data.metadata && typeof data.metadata === "object" ? data.metadata : {}) as Record<string, unknown>;
  const day = (String(meta.modified ?? "") || modified.toISOString()).slice(0, 10);
  const type = TYPES[String(data.type ?? meta.type ?? "")] ?? "project";
  return stringifyFrontMatter({ ...data, type, source: data.source ?? (!helper && (type === "person" || type === "feedback") ? "person" : "observed"), date: data.date ?? day, "last-verified": data["last-verified"] ?? day }, body);
}

/** The memory file an index line points to, if it is one: `- [Title](file.md) — hook`. */
function linkOf(line: string): string | null {
  return /^\s*[-*]\s*\[[^\]]*\]\(([^)]+)\)/.exec(line)?.[1] ?? null;
}

/**
 * Copy the memories Claude kept for an agent's folders into its memory/, once. Nothing is overwritten
 * and the originals stay: a file that already exists here with other text comes in as <name>.claude.md,
 * and the index lines for files not yet listed are added to the end of MEMORY.md.
 * Returns how many files came over.
 */
export async function importClaudeMemory(agentDir: string, cwds: string[]): Promise<{ files: number; from: string[] }> {
  // Claude names the folder after the real path (symlinks resolved), so both spellings are looked at.
  const real = await Promise.all(cwds.map((c) => realDir(c)));
  return importFrom(agentDir, [...new Set([...cwds, ...real].map(claudeMemoryDir))].map((dir) => ({ dir, prefix: "" })));
}

/**
 * The same for the memories Claude kept in the agent's helpers' folders (<agent folder>/.overtime/helpers/
 * <id>/…, which Claude files under the agent folder's name and "--overtime-helpers-"). Each comes in as
 * helper-<id>-<name>.md; one whose text is already in memory/ is left out.
 */
export async function importHelperClaudeMemory(agentDir: string): Promise<{ files: number; from: string[] }> {
  const projects = join(claudeMemoryDir(agentDir), "..", "..");
  const names = await readdir(projects).catch(() => [] as string[]);
  const sources: { dir: string; prefix: string }[] = [];
  for (const d of new Set([agentDir, await realDir(agentDir)])) {
    const lead = `${d.replace(/[^a-zA-Z0-9]/g, "-")}--overtime-helpers-`;
    for (const n of names.filter((x) => x.startsWith(lead)).sort()) {
      const id = /helper-\d{14}-([0-9a-f]+)/.exec(n)?.[1] ?? n.slice(lead.length).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
      sources.push({ dir: join(projects, n, "memory"), prefix: `helper-${id}-` });
    }
  }
  return importFrom(agentDir, sources);
}

async function importFrom(agentDir: string, sources: { dir: string; prefix: string }[]): Promise<{ files: number; from: string[] }> {
  const dest = join(agentDir, MEMORY_DIR);
  let files = 0;
  const from: string[] = [];
  for (const { dir: src, prefix } of sources) {
    let names: string[] = [];
    try {
      names = (await readdir(src)).filter((n) => n.endsWith(".md")).sort();
    } catch {
      continue;
    }
    if (!names.length) continue;
    from.push(src);
    await mkdir(dest, { recursive: true });
    // What's already here, by its text: a helper's copy of a memory the agent has isn't brought in twice.
    const have = new Set(prefix ? await Promise.all((await readdir(dest)).filter((n) => n.endsWith(".md")).map((n) => readFile(join(dest, n), "utf8").then((t) => parseFrontMatter(t).body.trim(), () => ""))) : []);
    /** Claude's name for a file → the name it has here. */
    const renamed = new Map<string, string>();
    for (const n of names.filter((n) => n !== MEMORY_INDEX)) {
      const text = withHeader(await readFile(join(src, n), "utf8"), (await stat(join(src, n))).mtime, !!prefix);
      if (prefix && have.has(parseFrontMatter(text).body.trim())) continue;
      let target = prefix + n;
      const existing = await readFile(join(dest, target), "utf8").catch(() => null);
      if (existing !== null && existing !== text) target = target.replace(/\.md$/, ".claude.md");
      if (existing === text || existsSync(join(dest, target))) {
        renamed.set(n, target);
        continue;
      }
      await writeFile(join(dest, target), text);
      renamed.set(n, target);
      files++;
    }
    const theirs = await readFile(join(src, MEMORY_INDEX), "utf8").catch(() => "");
    const ours = await readMemoryIndex(agentDir);
    const listed = new Set(ours.split("\n").map(linkOf).filter(Boolean));
    const add: string[] = [];
    for (const line of theirs.split("\n")) {
      const link = linkOf(line);
      if (!link || (prefix && !renamed.has(link))) continue;
      const target = renamed.get(link) ?? link;
      if (listed.has(target)) continue;
      listed.add(target);
      add.push(line.replace(`](${link})`, `](${target})`).trimEnd());
    }
    // A file Claude never put in its index still gets a line, so nothing that came over is lost from view.
    for (const target of renamed.values()) {
      if (listed.has(target)) continue;
      listed.add(target);
      const { data } = parseFrontMatter(await readFile(join(dest, target), "utf8"));
      add.push(`- [${String(data.name ?? target.replace(/\.md$/, ""))}](${target})${data.description ? ` — ${String(data.description)}` : ""}`);
    }
    if (add.length) await writeFile(memoryIndexPath(agentDir), `${ours.trimEnd()}${ours.trim() ? "\n" : ""}${add.join("\n")}\n`);
  }
  return { files, from };
}

// ---------- ageing and patterns ----------

/**
 * How long a fact that can change (can-change: true) holds without being checked again, by its type.
 * Rules and preferences don't age: only memories marked can-change do.
 */
export const STALE_DAYS: Record<string, number> = { project: 30, reference: 60, person: 60, feedback: 60 };
const STALE_MARK = /\s*\(possibly stale: last verified [^)]*\)/g;

const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v.trim() ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);
const yes = (v: unknown) => v === true || /^(true|yes)$/i.test(String(v ?? ""));

/**
 * Mark in MEMORY.md each fact that can change and hasn't been checked for too long ("(possibly stale:
 * last verified …)"), and unmark one that has been checked since, so the agent checks before relying on
 * it. Only that mark is ever touched; the rest of the index is as the agent wrote it. Returns how many
 * lines changed.
 */
export async function markStale(agentDir: string, now = new Date()): Promise<number> {
  const index = await readMemoryIndex(agentDir);
  if (!index.trim()) return 0;
  let changed = 0;
  const lines = await Promise.all(
    index.split("\n").map(async (line) => {
      const link = linkOf(line);
      if (!link) return line;
      const { data } = parseFrontMatter(await readFile(join(agentDir, MEMORY_DIR, link), "utf8").catch(() => ""));
      const checked = String(data["last-verified"] ?? data.date ?? "");
      const days = STALE_DAYS[String(data.type ?? "")] ?? 60;
      const stale = yes(data["can-change"]) && !!checked && now.getTime() - Date.parse(checked) > days * 86400_000;
      const bare = line.replace(STALE_MARK, "");
      const next = stale ? `${bare.trimEnd()} (possibly stale: last verified ${checked.slice(0, 10)})` : bare;
      if (next !== line) changed++;
      return next;
    }),
  );
  if (changed) await writeFile(memoryIndexPath(agentDir), lines.join("\n"));
  return changed;
}

/** At most this many patterns a reflect pass may infer at once, each from at least INFERRED_MIN_SUPPORT memories or runs. */
export const INFERRED_PER_PASS = 2;
export const INFERRED_MIN_SUPPORT = 3;

/**
 * Hold a reflect pass's inferred patterns (source: inferred) to their bounds: new ones need at least
 * INFERRED_MIN_SUPPORT supporting memories and runs, and only the first INFERRED_PER_PASS stay; every
 * inferred memory is marked unconfirmed, in its file and its index line. `before`: the memory files
 * there were before the pass. Returns the files it removed, and why.
 */
export async function boundInferred(agentDir: string, before: Set<string>): Promise<{ file: string; why: string }[]> {
  const dir = join(agentDir, MEMORY_DIR);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".md") && n !== MEMORY_INDEX);
  const removed: { file: string; why: string }[] = [];
  const fresh: { name: string; mtime: number }[] = [];
  const marked = new Set<string>();
  for (const n of names) {
    const text = await readFile(join(dir, n), "utf8").catch(() => "");
    const { data, body } = parseFrontMatter(text);
    if (String(data.source ?? "") !== "inferred") continue;
    marked.add(n);
    if (!yes(data.unconfirmed)) await writeFile(join(dir, n), stringifyFrontMatter({ ...data, unconfirmed: true }, body));
    if (before.has(n)) continue;
    const support = new Set([...listOf(data.runs), ...listOf(data.from)]).size;
    if (support < INFERRED_MIN_SUPPORT) removed.push({ file: n, why: `only ${support} supporting memories and runs` });
    else fresh.push({ name: n, mtime: (await stat(join(dir, n))).mtimeMs });
  }
  for (const f of fresh.sort((a, b) => a.mtime - b.mtime).slice(INFERRED_PER_PASS)) removed.push({ file: f.name, why: `more than ${INFERRED_PER_PASS} new patterns in one pass` });
  for (const r of removed) {
    await rm(join(dir, r.file), { force: true });
    marked.delete(r.file);
  }
  // The index: no line for a removed pattern, and "(unconfirmed)" on every inferred one.
  const index = await readMemoryIndex(agentDir);
  const gone = new Set(removed.map((r) => r.file));
  const next = index
    .split("\n")
    .filter((l) => !gone.has(linkOf(l) ?? ""))
    .map((l) => (marked.has(linkOf(l) ?? "") && !/\(unconfirmed\)/.test(l) ? `${l.trimEnd()} (unconfirmed)` : l))
    .join("\n");
  if (next !== index) await writeFile(memoryIndexPath(agentDir), next);
  return removed;
}

/** A fingerprint of everything in memory/ (names and contents), to tell whether a session changed it. */
export async function memoryFingerprint(agentDir: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const h = createHash("sha1");
  const dir = join(agentDir, MEMORY_DIR);
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(dir, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((x, y) => x.name.localeCompare(y.name))) {
      const p = join(rel, e.name);
      if (e.isDirectory()) await walk(p);
      else h.update(`${p}\0`).update(await readFile(join(dir, p)).catch(() => Buffer.alloc(0))).update("\0");
    }
  };
  await walk("");
  return h.digest("hex");
}

async function realDir(dir: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(dir).catch(() => dir);
}
