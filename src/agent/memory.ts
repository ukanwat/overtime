import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseFrontMatter, stringifyFrontMatter } from "./frontmatter.js";

const exec = promisify(execFile);

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

/** The index as an agent is shown it: all of it (never cut), with a note to consolidate when it's long. */
export function memoryText(index: string): string {
  const lines = index.trim().split("\n").length;
  const over = lines > MEMORY_CAP_LINES ? `\n\n(MEMORY.md is ${lines} lines, over the ${MEMORY_CAP_LINES}-line cap. Consolidate it now: merge overlapping memories, delete stale ones, and keep one line per memory.)` : "";
  return `${index.trim()}${over}`;
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

/** A Claude memory file with Overtime's header added (its own fields kept), so it reads like any other memory. */
function withHeader(text: string, modified: Date): string {
  const { data, body } = parseFrontMatter(text);
  const meta = (data.metadata && typeof data.metadata === "object" ? data.metadata : {}) as Record<string, unknown>;
  const day = (String(meta.modified ?? "") || modified.toISOString()).slice(0, 10);
  const type = TYPES[String(data.type ?? meta.type ?? "")] ?? "project";
  return stringifyFrontMatter({ ...data, type, source: data.source ?? "agent", date: data.date ?? day, "last-verified": data["last-verified"] ?? day }, body);
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
  const dest = join(agentDir, MEMORY_DIR);
  let files = 0;
  const from: string[] = [];
  // Claude names the folder after the real path (symlinks resolved), so both spellings are looked at.
  const real = await Promise.all(cwds.map((c) => realDir(c)));
  for (const src of [...new Set([...cwds, ...real].map(claudeMemoryDir))]) {
    let names: string[] = [];
    try {
      names = (await readdir(src)).filter((n) => n.endsWith(".md")).sort();
    } catch {
      continue;
    }
    if (!names.length) continue;
    from.push(src);
    await mkdir(dest, { recursive: true });
    /** Claude's name for a file → the name it has here. */
    const renamed = new Map<string, string>();
    for (const n of names.filter((n) => n !== MEMORY_INDEX)) {
      const text = withHeader(await readFile(join(src, n), "utf8"), (await stat(join(src, n))).mtime);
      let target = n;
      const existing = await readFile(join(dest, n), "utf8").catch(() => null);
      if (existing !== null && existing !== text) target = n.replace(/\.md$/, ".claude.md");
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
      if (!link) continue;
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

// ---------- history: the agent folder as a git repository ----------

/** What Overtime commits after each turn and reflect pass: what the agent has learned and who it is. */
export const TRACKED = [MEMORY_DIR, "skills", "AGENT.md", "INDEX.md"];
const AUTHOR = { name: "Overtime", email: "overtime@localhost" };
/** Marks a repository Overtime made and commits to (in the repository's own config). */
const MARK = "overtime.autocommit";

const GITIGNORE = `# Overtime's own bookkeeping (transcripts, state, helpers' folders)
.overtime/
node_modules/
.DS_Store
# Large and binary files: kept in the folder, not in its history
*.mp4
*.mov
*.wav
*.mp3
*.zip
*.tar.gz
*.dmg
*.blend
*.psd
`;

async function git(dir: string, args: string[]): Promise<string> {
  // Overtime's own author and no signing or hooks: the person's global git setup is never used for these.
  const { stdout } = await exec("git", ["-C", dir, "-c", `user.name=${AUTHOR.name}`, "-c", `user.email=${AUTHOR.email}`, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/**
 * Make the agent's folder a git repository Overtime commits to, if it isn't one yet. A folder that is
 * already inside a repository Overtime didn't make (the agent's own, or one around it) is left alone.
 * Returns whether Overtime can commit there, and why not.
 */
export async function ensureHistory(agentDir: string): Promise<{ ok: boolean; why?: string }> {
  let top = "";
  try {
    top = (await git(agentDir, ["rev-parse", "--show-toplevel"])).trim();
  } catch {}
  if (top) {
    const ours = await git(agentDir, ["config", "--local", "--get", MARK]).then((s) => s.trim() === "true", () => false);
    if (ours && top === (await realDir(agentDir))) return { ok: true };
    return { ok: false, why: top === (await realDir(agentDir)) ? "the folder is a git repository of its own" : `the folder is inside the git repository at ${top}` };
  }
  try {
    await git(agentDir, ["init", "-q"]);
    await git(agentDir, ["config", "--local", MARK, "true"]);
    await git(agentDir, ["config", "--local", "user.name", AUTHOR.name]);
    await git(agentDir, ["config", "--local", "user.email", AUTHOR.email]);
    if (!existsSync(join(agentDir, ".gitignore"))) await writeFile(join(agentDir, ".gitignore"), GITIGNORE);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, why: `git init failed: ${String(e?.message ?? e).split("\n")[0]}` };
  }
}

async function realDir(dir: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(dir).catch(() => dir);
}

/**
 * Commit what changed in memory/, skills/, AGENT.md and INDEX.md (or fewer of them; nothing else in the
 * folder), with the message given. Returns the commit's short id, or null when nothing changed or
 * Overtime doesn't commit here.
 */
export async function commitHistory(agentDir: string, message: string, only: string[] = TRACKED): Promise<string | null> {
  if (!(await ensureHistory(agentDir)).ok) return null;
  const tracked = new Set((await git(agentDir, ["ls-files", "--", ...only])).split("\n").filter(Boolean).map((f) => f.split("/")[0]));
  const paths = only.filter((p) => existsSync(join(agentDir, p)) || tracked.has(p));
  if (!paths.length) return null;
  await git(agentDir, ["add", "-A", "--", ...paths]);
  const staged = (await git(agentDir, ["diff", "--cached", "--name-only", "--", ...paths])).trim();
  if (!staged) return null;
  await git(agentDir, ["commit", "-q", "--no-verify", "-m", message, "--", ...paths]);
  return (await git(agentDir, ["rev-parse", "--short", "HEAD"])).trim();
}

/** Whether a folder is in a repository Overtime made for an agent's history (not a workspace of the agent's own). */
export async function inHistoryRepo(dir: string): Promise<boolean> {
  try {
    const top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
    return (await git(top, ["config", "--local", "--get", MARK])).trim() === "true";
  } catch {
    return false;
  }
}
