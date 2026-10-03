import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

/**
 * Overtime's own sandbox, the same for every backend. The whole backend process (and everything it
 * starts: shells, scripts, MCP servers, editors) runs inside an operating-system sandbox that lets it
 * read anywhere but write only where the agent's work lives. A command the guard can't see into
 * (a script, a program the agent wrote) still can't touch anything else.
 *
 * macOS: Seatbelt (sandbox-exec). Linux: bubblewrap (bwrap), when installed.
 */

export interface SandboxSpec {
  /** Folders (and files) the agent may write. Everything else is read-only. */
  writable: string[];
  /** Paths inside those that stay read-only anyway (your own config that happens to live there). */
  protected?: string[];
}

export interface Launch {
  command: string;
  args: string[];
  /** Whether the process really runs sandboxed. */
  sandboxed: boolean;
  /** Why not, when it isn't. */
  why?: string;
}

/** Where each backend keeps its own state (sessions, logs, login refresh). It must be able to write there. */
export function backendStatePaths(backend: string): string[] {
  const h = homedir();
  switch (backend) {
    case "claude":
      return [join(h, ".claude"), join(h, ".claude.json"), join(h, ".claude.json.backup"), join(h, ".claude.json.lock")];
    case "codex":
      return [join(h, ".codex")];
    case "gemini":
      return [join(h, ".gemini")];
    default:
      return [];
  }
}

/**
 * Your own configuration that lives inside folders a backend must write: never writable, so an agent
 * can't plant hooks, commands or settings into the tools you use yourself.
 */
export function protectedPaths(): string[] {
  const c = join(homedir(), ".claude");
  const x = join(homedir(), ".codex");
  const g = join(homedir(), ".gemini");
  return [
    ...["settings.json", "settings.local.json", "CLAUDE.md", "keybindings.json", "hooks", "commands", "agents", "skills", "plugins", "output-styles"].map((f) => join(c, f)),
    ...["config.toml", "AGENTS.md", "prompts", "rules"].map((f) => join(x, f)),
    ...["settings.json", "GEMINI.md", "extensions", "commands", "policies"].map((f) => join(g, f)),
  ];
}

/** Shared caches that package managers and toolchains write to; writing a cache can't harm your files. */
export function cachePaths(): string[] {
  const h = homedir();
  return [
    join(h, "Library", "Caches"),
    join(h, ".cache"),
    join(h, ".npm"),
    join(h, ".pnpm-store"),
    join(h, ".bun", "install", "cache"),
    join(h, ".yarn", "berry", "cache"),
    join(h, ".cargo", "registry"),
    join(h, ".cargo", "git"),
    join(h, "go", "pkg", "mod"),
    join(h, ".gradle", "caches"),
    join(h, ".m2", "repository"),
  ];
}

/**
 * Where tools get installed, so agents can install what their work needs (brew, npm -g, pip --user,
 * cargo, rustup, nvm, pyenv, go, bun, deno). System-wide installs need sudo, which the guard refuses.
 */
export function installPaths(): string[] {
  const h = homedir();
  return [
    "/opt/homebrew",
    "/usr/local",
    join(h, ".local"),
    join(h, "Library", "Python"),
    join(h, ".cargo"),
    join(h, ".rustup"),
    join(h, ".nvm"),
    join(h, ".pyenv"),
    join(h, ".rbenv"),
    join(h, ".gem"),
    join(h, "go"),
    join(h, ".bun"),
    join(h, ".deno"),
    join(h, ".volta"),
    join(h, ".npm-global"),
    join(h, ".config", "pnpm"),
    join(h, "Library", "pnpm"),
    join(h, ".gradle"),
    join(h, ".m2"),
  ];
}

function tempPaths(): string[] {
  return [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
}

/** The real path, so symlinked folders (/tmp, /var on macOS) match what the kernel checks. */
function real(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    // Not created yet: resolve the nearest existing parent.
    const parent = resolve(abs, "..");
    if (parent === abs) return abs;
    return join(real(parent), abs.slice(parent.length + 1));
  }
}

function unique(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) if (p) out.add(real(p));
  return [...out];
}

/** Seatbelt profile: allow everything except writing outside the given paths. */
export function seatbeltProfile(writable: string[], prot: string[] = []): string {
  const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const allow = unique([...writable, ...tempPaths()]).map((p) => `  (subpath ${q(p)})`);
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    "(allow file-write*",
    ...allow,
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ptmx$") (regex #"^/dev/ttys")',
    ")",
    // Later rules win: your own config stays read-only even inside a writable folder.
    ...(prot.length ? ["(deny file-write*", ...unique(prot).map((p) => `  (subpath ${q(p)})`), ")"] : []),
  ].join("\n");
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

/** Whether Overtime can sandbox on this machine, and if not, why. */
export function sandboxAvailable(): { ok: boolean; why?: string } {
  if (process.platform === "darwin") return existsSync("/usr/bin/sandbox-exec") ? { ok: true } : { ok: false, why: "sandbox-exec is missing from this Mac" };
  if (process.platform === "linux") return findBwrap() ? { ok: true } : { ok: false, why: "bubblewrap isn't installed (apt install bubblewrap / dnf install bubblewrap)" };
  return { ok: false, why: `no sandbox support on ${process.platform}` };
}

/** How to launch a command inside the sandbox. */
export function sandboxLaunch(command: string, args: string[], spec: SandboxSpec): Launch {
  const avail = sandboxAvailable();
  if (!avail.ok) return { command, args, sandboxed: false, why: avail.why };
  if (process.platform === "darwin") {
    return { command: "/usr/bin/sandbox-exec", args: ["-p", seatbeltProfile(spec.writable, spec.protected), command, ...args], sandboxed: true };
  }
  // Linux: the whole filesystem read-only, the writable paths bound back read-write.
  const binds: string[] = [];
  for (const p of unique([...spec.writable, ...tempPaths()])) {
    if (existsSync(p)) binds.push("--bind", p, p);
  }
  for (const p of unique(spec.protected ?? [])) if (existsSync(p)) binds.push("--ro-bind", p, p);
  return {
    command: findBwrap()!,
    args: ["--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev", "--proc", "/proc", ...binds, "--die-with-parent", "--", command, ...args],
    sandboxed: true,
  };
}

/** What an agent's sessions and watches may write: its folder, its workspace, caches and its backend's state. */
export async function sandboxSpec(agentDir: string, workspaces: string[], backend: string): Promise<SandboxSpec> {
  const { loadSettings } = await import("../settings.js");
  const custom = (await loadSettings()).customBackends[backend]?.writable ?? [];
  return { writable: [agentDir, ...workspaces, ...backendStatePaths(backend), ...custom, ...cachePaths(), ...installPaths()], protected: protectedPaths() };
}
