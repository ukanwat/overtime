import { existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Protected paths. Agents have full access to your machine by default: they write anywhere your user
 * can. The paths you list as protected (in settings, for all agents or one) are made read-only for the
 * whole backend process and everything it starts (shells, scripts, programs it wrote, its watches),
 * by the operating system: Seatbelt on macOS, bubblewrap on Linux. Nothing is protected unless you list it.
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

/** Seatbelt profile: everything allowed, except writing to the protected paths. */
export function seatbeltProfile(protect: string[]): string {
  const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return ["(version 1)", "(allow default)", "(deny file-write*", ...unique(protect).map((p) => `  (subpath ${q(p)})`), ")"].join("\n");
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

/** How to launch a command with the given paths read-only. No paths: launched as is. */
export function sandboxLaunch(command: string, args: string[], protect: string[]): Launch {
  if (!protect.length) return { command, args, sandboxed: false };
  const avail = sandboxAvailable();
  if (!avail.ok) return { command, args, sandboxed: false, why: avail.why };
  if (process.platform === "darwin") return { command: "/usr/bin/sandbox-exec", args: ["-p", seatbeltProfile(protect), command, ...args], sandboxed: true };
  const ro: string[] = [];
  for (const p of unique(protect)) if (existsSync(p)) ro.push("--ro-bind", p, p);
  return { command: findBwrap()!, args: ["--bind", "/", "/", "--dev-bind", "/dev", "/dev", "--proc", "/proc", ...ro, "--die-with-parent", "--", command, ...args], sandboxed: true };
}
