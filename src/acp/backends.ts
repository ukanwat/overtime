import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
 *
 * And no memory system of the backend's own: an agent keeps what it learns in its folder (memory/),
 * the same on every backend. Claude's auto-memory is off here and in its session options; Codex's
 * memories feature is off in the agent's own config (see codexMemoriesOff); Gemini's in a project
 * settings file in the agent's folder (see geminiMemoryOff). OpenCode has no memory of its own: only
 * plugins in the person's own config add one.
 */
export async function isolationEnv(backend: string, agentMeta: string): Promise<Record<string, string>> {
  if (backend === "claude") return { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
  if (backend !== "codex") return {};
  const own = join(agentMeta, "codex-home");
  await mkdir(own, { recursive: true });
  const theirs = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
  const link = join(own, "auth.json");
  await shareSignIn(theirs, link);
  await codexMemoriesOff(join(own, "config.toml"));
  return { CODEX_HOME: own };
}

/**
 * Gemini CLI's memory off for sessions in this folder, through its project settings
 * (<cwd>/.gemini/settings.json): its save_memory tool excluded (older versions have one) and Auto Memory
 * off. Anything else in the file is kept. Gemini reads project settings only in a folder it trusts.
 */
export async function geminiMemoryOff(cwd: string): Promise<void> {
  const file = join(cwd, ".gemini", "settings.json");
  let cur: any = {};
  try {
    cur = JSON.parse(await readFile(file, "utf8"));
  } catch (e: any) {
    if (e?.code !== "ENOENT") return; // a file that isn't JSON is the person's to fix, not ours to replace
  }
  if (!cur || typeof cur !== "object") return;
  const exclude: string[] = Array.isArray(cur.tools?.exclude) ? cur.tools.exclude : [];
  if (exclude.includes("save_memory") && cur.experimental?.autoMemory === false) return;
  const next = { ...cur, tools: { ...(cur.tools ?? {}), exclude: [...new Set([...exclude, "save_memory"])] }, experimental: { ...(cur.experimental ?? {}), autoMemory: false } };
  await mkdir(join(cwd, ".gemini"), { recursive: true });
  await writeFile(file, JSON.stringify(next, null, 2) + "\n");
}

/**
 * Codex's memories off in the agent's own config.toml: the feature itself, and its [memories] settings
 * (neither generating new memories nor using old ones). It's off by default today; this keeps it off if
 * that changes. What the file already says about memories is left as it is.
 */
export async function codexMemoriesOff(file: string): Promise<void> {
  let cur = await readFile(file, "utf8").catch(() => "");
  const before = cur;
  const end = () => (cur && !cur.endsWith("\n") ? "\n" : "") + (cur ? "\n" : "");
  if (!/^\s*\[memories\]/m.test(cur)) cur += `${end()}[memories]\ngenerate_memories = false\nuse_memories = false\n`;
  const features = /^\s*\[features\]\s*$/m.exec(cur);
  const featureSet = features && /^\s*memories\s*=/m.test(cur.slice(features.index).split(/^\s*\[(?!features\])/m)[0]);
  if (!featureSet) {
    cur = features ? `${cur.slice(0, features.index + features[0].length)}\nmemories = false${cur.slice(features.index + features[0].length)}` : `${cur}${end()}[features]\nmemories = false\n`;
  }
  if (cur !== before) await writeFile(file, cur);
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
