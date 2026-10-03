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
  /** Daily spend cap per agent, in US dollars, counted from the cost the backend itself reports. */
  dailyBudgetUsd: number;
  /** Daily token cap per agent, for backends that report no cost (null = no token cap). Exact counts from the backend. */
  dailyTokenBudget: number | null;
  /** Longest a single turn may run before Overtime cancels it, in minutes. */
  turnTimeoutMinutes: number;
  /** MCP servers given to every agent. */
  mcpServers: McpServerConfig[];
  /** Whether the person has been asked about starting the daemon at login (asked once). */
  autostartAsked?: boolean;
  /** Extra ACP backends: name -> command line that speaks ACP on stdio. */
  customBackends: Record<string, { command: string; args?: string[] }>;
}

export const DEFAULT_SETTINGS: Settings = {
  backend: "claude",
  model: null,
  dailyBudgetUsd: 100,
  dailyTokenBudget: null,
  turnTimeoutMinutes: 180,
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
