import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { loadSettings } from "../settings.js";

export interface BackendCommand {
  command: string;
  args: string[];
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

function onPath(cmd: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v "${cmd.replace(/"/g, "")}"`], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

let geminiFlag: string | undefined;
/** Gemini CLI renamed --experimental-acp to --acp; use whichever the installed version knows. */
function geminiAcpFlag(): string {
  if (geminiFlag) return geminiFlag;
  try {
    const help = execFileSync("gemini", ["--help"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    geminiFlag = /(^|\s)--acp\b/m.test(help) ? "--acp" : "--experimental-acp";
  } catch {
    geminiFlag = "--acp";
  }
  return geminiFlag;
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
      return { command: "gemini", args: [geminiAcpFlag()] };
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
