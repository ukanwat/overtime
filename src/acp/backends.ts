import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, rm, stat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../settings.js";

export interface BackendCommand {
  command: string;
  args: string[];
  /** Other arguments to try, in order, if the backend exits straight away with these (an older version). */
  fallbackArgs?: string[][];
}

const require = createRequire(import.meta.url);

/** Built-in backends: any other ACP agent can be added under customBackends in settings.json. */
export const BUILTIN_BACKENDS = ["claude", "codex", "gemini", "opencode"];

/** What to install when a built-in backend's command isn't there. */
const INSTALL: Record<string, string> = {
  codex: "npx (comes with Node.js), and sign in to Codex once with `npx @openai/codex login`",
  gemini: "Gemini CLI: npm install -g @google/gemini-cli, then run `gemini` once to sign in",
  opencode: "OpenCode: brew install sst/tap/opencode (or npm install -g opencode-ai), then `opencode auth login`",
};

/** Whether a command can be run: an existing file for a path, or found on PATH for a bare name. */
export function commandExists(cmd: string): boolean {
  if (cmd.includes("/")) return existsSync(cmd);
  return onPath(cmd);
}

function onPath(cmd: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v "${cmd.replace(/"/g, "")}"`], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}


/** How to start each backend as an ACP agent on stdio. */
export async function backendCommand(name: string): Promise<BackendCommand> {
  const custom = (await loadSettings()).customBackends[name];
  if (custom) return { command: custom.command, args: custom.args ?? [] };
  switch (name) {
    case "claude": {
      // Bundled dependency, so Claude works with no extra install (it uses your Claude Code login).
      const entry = require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");
      return { command: process.execPath, args: [entry] };
    }
    case "codex":
      return { command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"] };
    case "gemini":
      // Gemini CLI renamed --experimental-acp to --acp; an older version exits on the new flag, and
      // then the old one is tried (see AcpSession.open).
      return { command: "gemini", args: ["--acp"], fallbackArgs: [["--experimental-acp"]] };
    case "opencode":
      return { command: "opencode", args: ["acp"] };
    default:
      throw new Error(`Unknown backend "${name}". Use ${BUILTIN_BACKENDS.join(", ")}, or add it under customBackends in settings.json.`);
  }
}

/** Why a backend can't start on this machine (its command isn't installed), or null if it can. */
export async function backendMissing(name: string): Promise<string | null> {
  const custom = (await loadSettings()).customBackends[name];
  if (custom) return custom.command.includes("/") || onPath(custom.command) ? null : `"${custom.command}" isn't installed or isn't on your PATH.`;
  if (name === "claude") return null;
  if (!BUILTIN_BACKENDS.includes(name)) return `Unknown backend "${name}".`;
  return onPath(name === "codex" ? "npx" : name) ? null : `${name} isn't installed. Install ${INSTALL[name]}.`;
}

/**
 * Keeping an agent apart from the person's own setup of a backend: their personal MCP servers,
 * instructions, skills and settings. Claude gets this through its session options (see AcpSession).
 * Codex reads everything from its home folder, so each agent gets its own (CODEX_HOME), sharing only
 * the person's sign-in. Gemini and OpenCode have no such switch: they also read the person's own setup.
 */
export async function isolationEnv(backend: string, agentMeta: string): Promise<Record<string, string>> {
  if (backend !== "codex") return {};
  const own = join(agentMeta, "codex-home");
  await mkdir(own, { recursive: true });
  const theirs = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
  const link = join(own, "auth.json");
  await shareSignIn(theirs, link);
  return { CODEX_HOME: own };
}

/**
 * The agent's Codex uses the person's sign-in through a link to their auth.json. If Codex replaced the
 * link with a file of its own (it refreshed the sign-in), the newer of the two is the valid one: it's
 * copied to the person's, and the link put back.
 */
export async function shareSignIn(theirs: string, link: string): Promise<void> {
  const st = await lstat(link).catch(() => null);
  if (st?.isSymbolicLink()) return;
  if (st?.isFile()) {
    const mine = st.mtimeMs;
    const other = (await stat(theirs).catch(() => null))?.mtimeMs ?? 0;
    if (mine > other) await copyFile(link, theirs);
    await rm(link, { force: true });
  }
  if (existsSync(theirs)) await symlink(theirs, link).catch(() => {});
}
