import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { PermissionRequest } from "../acp/session.js";
import { realPath, type WriteLayer } from "./sandbox.js";

/**
 * A session that may write only in a few folders (a reflect pass: only the agent's memory/). Enforced
 * three ways, so it holds on every backend and system:
 * 1. The operating system (writeLayers, through the sandbox): everything Overtime keeps and the person's
 *    files are read-only for the backend and all it starts, except those folders. Where there's no
 *    sandbox, the other two still hold.
 * 2. Permission requests (inScope): a backend that asks before it edits or runs a command is refused
 *    anything outside those folders, and every command.
 * 3. Afterwards (OwnWrites): a file outside them that the session's own file tools changed is put back,
 *    but only while it is still exactly as the session left it, so an edit someone else made meanwhile
 *    (the person, the agent's next turn) is never undone. A backend can run a tool before Overtime has
 *    read its announcement, so the files that matter most are copied before the session starts.
 */

/** Folders under the person's home where backends keep their own state, caches and sign-in: they stay writable. */
const BACKEND_DIRS = [".claude", ".codex", ".gemini", ".config", ".local", ".cache", ".npm", ".bun", ".opencode", "Library"];

/**
 * The sandbox layers for a session that may write only in `writable` (later layers win): the person's
 * home (macOS only, see below), Overtime's home, the agent's folder and its workspace read-only; the
 * backends' own folders and the writable ones writable again.
 */
export function writeLayers(writable: string[], roots: { overtimeHome: string; agentDir: string; workspace: string }): WriteLayer[] {
  const home = homedir();
  const layers: WriteLayer[] = [];
  // On Linux, bubblewrap can make the home read-only only by mounting over it, and then a backend's
  // sign-in file that is replaced by rename (~/.claude.json) can't be written: there, the home stays as it is.
  if (process.platform === "darwin") {
    layers.push({ write: false, paths: [home] });
    layers.push({ write: true, paths: BACKEND_DIRS.map((d) => join(home, d)), prefixes: [join(home, ".claude.json")] });
  }
  layers.push({ write: false, paths: [roots.overtimeHome, roots.agentDir, roots.workspace] });
  layers.push({ write: true, paths: writable });
  return layers;
}

const inside = (p: string, dirs: string[]) => {
  const r = realPath(p);
  return dirs.some((d) => r === d || r.startsWith(d.endsWith("/") ? d : `${d}/`));
};

/** The files a tool call names: its locations and the path fields of its input. */
export function callPaths(call: any, cwd: string): string[] {
  const out = new Set<string>();
  for (const l of Array.isArray(call?.locations) ? call.locations : []) if (typeof l?.path === "string") out.add(l.path);
  const i = call?.rawInput && typeof call.rawInput === "object" ? call.rawInput : {};
  for (const k of ["file_path", "path", "notebook_path", "destination", "target", "new_path", "old_path"]) if (typeof i[k] === "string" && i[k]) out.add(i[k]);
  return [...out].map((p) => (isAbsolute(p) ? p : resolve(cwd, p)));
}

/** Whether a tool call may change files: by its kind, or by being one of the file-writing tools. */
function writes(call: any): boolean {
  const kind = String(call?.kind ?? "");
  if (["edit", "delete", "move"].includes(kind)) return true;
  const tool = String(call?._meta?.claudeCode?.toolName ?? call?.title ?? "");
  return /^(Write|Edit|MultiEdit|NotebookEdit)\b/.test(tool);
}

/** The answer to a permission request from a session that may write only in `writable`. */
export function inScope(req: PermissionRequest, writable: string[], cwd: string): { allowed: boolean; reason: string } {
  const call: any = req.toolCall ?? {};
  const kind = String(call.kind ?? "");
  if (kind === "execute") return { allowed: false, reason: "this session works with file tools only: no commands" };
  if (kind === "fetch") return { allowed: false, reason: "this session doesn't go online" };
  if (!writes(call)) return { allowed: true, reason: "allowed" };
  const dirs = writable.map(realPath);
  const targets = callPaths(call, cwd);
  if (!targets.length) return { allowed: false, reason: "a change to files it doesn't name" };
  const out = targets.filter((p) => !inside(p, dirs));
  return out.length ? { allowed: false, reason: `only ${writable.join(", ")} may be changed in this session, not ${out.join(", ")}` } : { allowed: true, reason: "allowed" };
}

const hash = (p: string): string | null => {
  try {
    return createHash("sha1").update(readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
};
const content = (p: string): Buffer | null => {
  try {
    return readFileSync(p);
  } catch {
    return null;
  }
};

const modifiedMs = (p: string): number | null => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * The files outside `writable` that a session's own file tools touched: each as it was just before
 * the session first touched it, and as the session's last write to it left it.
 */
export class OwnWrites {
  private before = new Map<string, Buffer | null>();
  private left = new Map<string, string | null>();
  private open = new Map<string, string[]>();
  /** Files someone else changed between two of the session's writes to them: never put back. */
  private others = new Set<string>();
  /** The `keep` files as they were when the session started (by real path). */
  private start = new Map<string, Buffer | null>();
  /** Files already changed during the session when Overtime first heard of the tool: how they were before is unknown. */
  private late = new Set<string>();
  private readonly startedMs = Date.now();
  private readonly dirs: string[];

  /**
   * `keep`: files copied now, before the session starts. A tool's announcement is a message the backend
   * sends and doesn't wait on, so its write can land before Overtime reads it, and a copy taken then
   * would already be the changed file. Without a sandbox to stop the write, these are still put back.
   */
  constructor(writable: string[], private readonly cwd: string, keep: string[] = []) {
    this.dirs = writable.map(realPath);
    for (const p of keep) if (!inside(p, this.dirs)) this.start.set(realPath(p), content(p));
  }

  /** Every streamed update of the session, in order. */
  see(u: any): void {
    if (u?.sessionUpdate !== "tool_call" && u?.sessionUpdate !== "tool_call_update") return;
    const id = String(u.toolCallId ?? "");
    const known = this.open.get(id);
    if (u.sessionUpdate === "tool_call" || writes(u) || known) {
      const targets = callPaths(u, this.cwd).filter((p) => !inside(p, this.dirs));
      if (targets.length && (writes(u) || known)) {
        // Before the tool runs (its first update announces it): how the file is now. A file it wrote
        // before that has changed since was edited by someone else too: theirs is kept, whatever happens.
        for (const p of targets) {
          const real = realPath(p);
          if (!this.before.has(p) && this.start.has(real)) this.before.set(p, this.start.get(real)!);
          else if (!this.before.has(p)) {
            this.before.set(p, content(p));
            // Changed since the session started: maybe by this very tool, before Overtime heard of it.
            const m = modifiedMs(p);
            if (m !== null && m >= this.startedMs) this.late.add(p);
          } else if (!known && this.left.has(p) && this.left.get(p) !== hash(p)) this.others.add(p);
        }
        this.open.set(id, [...new Set([...(known ?? []), ...targets])]);
      }
    }
    const mine = this.open.get(id);
    if (mine && (u.status === "completed" || u.status === "failed")) {
      for (const p of mine) this.left.set(p, hash(p));
      this.open.delete(id);
    }
  }

  /**
   * Put back what the session changed outside `writable`, once it has ended. A file someone else
   * changed after the session's last write to it is left as it is. Returns what was put back, what was
   * left, and what it may have changed before Overtime could copy it (left as it is: there's nothing to put back).
   */
  async undo(): Promise<{ restored: string[]; kept: string[]; uncopied: string[] }> {
    const restored: string[] = [];
    const kept: string[] = [];
    const uncopied: string[] = [];
    // A tool cut off when the session stopped never said it finished: what it left is as it is now.
    for (const ps of this.open.values()) for (const p of ps) this.left.set(p, hash(p));
    this.open.clear();
    for (const [p, was] of this.before) {
      const now = hash(p);
      const wasHash = was === null ? null : createHash("sha1").update(was).digest("hex");
      if (now === wasHash) {
        if (this.late.has(p) && this.left.get(p) === now) uncopied.push(p);
        continue;
      }
      // Changed by its own tool, and nothing since: the session's change, so it's undone.
      if (!this.others.has(p) && this.left.has(p) && this.left.get(p) === now) {
        if (was === null) await rm(p, { force: true });
        else await writeFile(p, was);
        restored.push(p);
      } else kept.push(p);
    }
    return { restored, kept, uncopied };
  }
}
