import { createRequire } from "node:module";
import { loadSettings } from "../settings.js";

export interface BackendCommand {
  command: string;
  args: string[];
}

const require = createRequire(import.meta.url);

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
      return { command: "gemini", args: ["--experimental-acp"] };
    default:
      throw new Error(`Unknown backend "${name}". Use claude, codex, gemini, or add it under customBackends in settings.json.`);
  }
}

export const BUILTIN_BACKENDS = ["claude", "codex", "gemini"];
