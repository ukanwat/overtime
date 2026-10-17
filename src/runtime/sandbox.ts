import { existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Protected paths. Agents have full access to your machine by default: they write anywhere your user
 * can. The paths you list as protected (in settings, for all agents or one) are made read-only for the
 * whole backend process and everything it starts (shells, scripts, programs it wrote, its watches),
 * by the operating system: Seatbelt on macOS, bubblewrap on Linux. Nothing is protected unless you list it.
 *
 * Hidden paths (private agents' folders, for every other agent) can't be read at all. Only on macOS:
 * bubblewrap can only cover a folder with an empty one, where writes would quietly vanish, so on Linux
 * they stay readable.
 */

export interface Launch {
  command: string;
  args: string[];
  /** Whether the protection is really in force. */
  sandboxed: boolean;
  /** Why not, when it isn't. */
  why?: string;
}

/** "~/Documents" and relative paths to real absolute paths, so symlinked folders match what the kernel checks. */
export function realPath(p: string): string {
  const h = p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
  const abs = resolve(h);
  try {
    return realpathSync(abs);
  } catch {
    const parent = resolve(abs, "..");
    if (parent === abs) return abs;
    return join(realPath(parent), abs.slice(parent.length + 1));
  }
}

function unique(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean).map(realPath))];
}

/**
 * A layer of write rules on top of the protected paths, for a session that may write only in a few
 * places (see runtime/write-scope.ts). Later layers win over earlier ones; the person's protected paths
 * win over all of them. `prefixes`: files whose path starts with one of these (a file and its backups).
 */
export interface WriteLayer {
  write: boolean;
  paths: string[];
  prefixes?: string[];
}

/** Seatbelt profile: everything allowed, except writing to the protected paths and reading the hidden ones. */
export function seatbeltProfile(protect: string[], hide: string[] = [], layers: WriteLayer[] = []): string {
  const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const rx = (s: string) => q(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  const rule = (what: string, list: string[], verb = "deny", prefixes: string[] = []) =>
    list.length || prefixes.length ? [`(${verb} ${what}`, ...unique(list).map((p) => `  (subpath ${q(p)})`), ...unique(prefixes).map((p) => `  (regex ${rx(p)})`), ")"] : [];
  // In a Seatbelt profile the last rule that matches decides: the layers in order, then the protected paths.
  const scoped = layers.flatMap((l) => rule("file-write*", l.paths, l.write ? "allow" : "deny", l.prefixes));
  return ["(version 1)", "(allow default)", ...scoped, ...rule("file-write*", protect), ...rule("file-read*", hide)].join("\n");
}

let bwrapPath: string | null | undefined;
function findBwrap(): string | null {
  if (bwrapPath !== undefined) return bwrapPath;
  try {
    bwrapPath = execFileSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" }).trim() || null;
  } catch {
    bwrapPath = null;
  }
  return bwrapPath;
}

/** Whether this machine can enforce protected paths, and if not, why. */
export function sandboxAvailable(): { ok: boolean; why?: string } {
  if (process.platform === "darwin") return existsSync("/usr/bin/sandbox-exec") ? { ok: true } : { ok: false, why: "sandbox-exec is missing from this Mac" };
  if (process.platform === "linux") return findBwrap() ? { ok: true } : { ok: false, why: "bubblewrap isn't installed (apt install bubblewrap / dnf install bubblewrap)" };
  return { ok: false, why: `protected paths aren't supported on ${process.platform}` };
}

/** How to launch a command with the given paths read-only (and, on macOS, the hidden ones unreadable). No paths: launched as is. */
export function sandboxLaunch(command: string, args: string[], protect: string[], hide: string[] = [], layers: WriteLayer[] = []): Launch {
  if (process.platform !== "darwin") hide = [];
  if (!protect.length && !hide.length && !layers.length) return { command, args, sandboxed: false };
  const avail = sandboxAvailable();
  if (!avail.ok) return { command, args, sandboxed: false, why: avail.why };
  if (process.platform === "darwin") return { command: "/usr/bin/sandbox-exec", args: ["-p", seatbeltProfile(protect, hide, layers), command, ...args], sandboxed: true };
  // bubblewrap applies its mounts in order, so a later one over a folder wins, as the layers do.
  const mounts: string[] = [];
  for (const l of layers) for (const p of unique(l.paths)) if (existsSync(p)) mounts.push(l.write ? "--bind" : "--ro-bind", p, p);
  for (const p of unique(protect)) if (existsSync(p)) mounts.push("--ro-bind", p, p);
  return { command: findBwrap()!, args: ["--bind", "/", "/", "--dev-bind", "/dev", "/dev", "--proc", "/proc", ...mounts, "--die-with-parent", "--", command, ...args], sandboxed: true };
}
