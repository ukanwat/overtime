import { paths } from "./paths.js";
import { readJson, writeJson } from "./fsutil.js";

export interface McpServerConfig {
  name: string;
  /** stdio servers */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http servers */
  url?: string;
  headers?: Record<string, string>;
}

export interface Settings {
  /** Backend used by new agents unless they say otherwise: claude | codex | gemini | a custom name below. */
  backend: string;
  /** Model id, or null for the backend's own default. */
  model: string | null;
  /** Daily budget per agent, in US dollars (estimated from tokens when the backend reports no cost). */
  dailyBudgetUsd: number;
  /** MCP servers given to every agent. */
  mcpServers: McpServerConfig[];
  /** Extra ACP backends: name -> command line that speaks ACP on stdio. */
  customBackends: Record<string, { command: string; args?: string[] }>;
}

export const DEFAULT_SETTINGS: Settings = {
  backend: "claude",
  model: null,
  dailyBudgetUsd: 10,
  mcpServers: [],
  customBackends: {},
};

export async function loadSettings(): Promise<Settings> {
  const s = await readJson<Partial<Settings>>(paths.settings(), {});
  return { ...DEFAULT_SETTINGS, ...s };
}

export async function saveSettings(s: Settings): Promise<void> {
  await writeJson(paths.settings(), s);
}
