import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../paths.js";
import { readJson, writeJson } from "../fsutil.js";
import { parseFrontMatter } from "./frontmatter.js";
import { loadSettings, type McpServerConfig } from "../settings.js";

export const FORMAT_VERSION = 1;

/** Settings an agent carries at the top of its AGENT.md. All optional; defaults come from settings.json. */
export interface AgentSettings {
  backend?: string;
  model?: string | null;
  dailyBudgetUsd?: number;
  /** Where the work lives. Defaults to the agent's own folder. */
  workspace?: string;
  /** Extra MCP servers for this agent only. */
  mcpServers?: McpServerConfig[];
  /** Names of shared MCP servers this agent should not get. */
  disableMcp?: string[];
}

export type AgentStatus = "new" | "working" | "asleep" | "stopped" | "error";

export interface AgentState {
  formatVersion: number;
  status: AgentStatus;
  /** One line on what it is doing right now, shown in the agent list. */
  activity: string;
  /** ISO time of the next wake-up, or null when stopped. */
  nextWake: string | null;
  /** ACP session id of the current main session, if any. */
  mainSessionId: string | null;
  /** Backend the main session belongs to; a backend change forces a fresh session. */
  mainSessionBackend: string | null;
  createdAt: string;
  lastRunAt: string | null;
  lastError: string | null;
}

export interface Agent {
  name: string;
  dir: string;
  settings: AgentSettings;
  /** The body of AGENT.md: who it is and its job. */
  identity: string;
  /** Contents of INDEX.md, or "" if the agent hasn't written one yet. */
  index: string;
  state: AgentState;
}

/** Resolved settings: the agent's own values over the global defaults. */
export interface EffectiveSettings {
  backend: string;
  model: string | null;
  dailyBudgetUsd: number;
  workspace: string;
  mcpServers: McpServerConfig[];
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function validateName(name: string): string | null {
  if (!NAME_RE.test(name)) return "Use lowercase letters, numbers and dashes (up to 40 characters), starting with a letter or number.";
  return null;
}

/** The AGENT.md a brand-new agent starts with: no identity yet. It replaces this itself after its first conversation. */
export function blankAgentMd(name: string): string {
  return `# ${name}\n\nNo identity yet. This agent was just created. In its first conversation it will learn who it is and what it's for, and rewrite this file itself.\n`;
}

export async function createAgent(name: string, settings: AgentSettings = {}): Promise<Agent> {
  const err = validateName(name);
  if (err) throw new Error(err);
  const dir = paths.agent(name);
  if (existsSync(dir)) throw new Error(`An agent called "${name}" already exists.`);
  await mkdir(paths.meta(name), { recursive: true });
  const { stringifyFrontMatter } = await import("./frontmatter.js");
  await writeFile(join(dir, "AGENT.md"), stringifyFrontMatter(settings as Record<string, unknown>, blankAgentMd(name)));
  const state: AgentState = {
    formatVersion: FORMAT_VERSION,
    status: "new",
    activity: "waiting for its job",
    nextWake: null,
    mainSessionId: null,
    mainSessionBackend: null,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    lastError: null,
  };
  await writeJson(join(paths.meta(name), "state.json"), state);
  return loadAgent(name);
}

export async function loadAgent(name: string): Promise<Agent> {
  const dir = paths.agent(name);
  if (!existsSync(join(dir, "AGENT.md"))) throw new Error(`No agent called "${name}".`);
  const { data, body } = parseFrontMatter(await readFile(join(dir, "AGENT.md"), "utf8"));
  let index = "";
  try {
    index = await readFile(join(dir, "INDEX.md"), "utf8");
  } catch {}
  const state = await readJson<AgentState>(join(paths.meta(name), "state.json"), {
    formatVersion: FORMAT_VERSION,
    status: "new",
    activity: "",
    nextWake: null,
    mainSessionId: null,
    mainSessionBackend: null,
    createdAt: (await stat(dir)).birthtime.toISOString(),
    lastRunAt: null,
    lastError: null,
  });
  return { name, dir, settings: data as AgentSettings, identity: body, index, state };
}

export async function listAgents(): Promise<Agent[]> {
  let names: string[] = [];
  try {
    names = (await readdir(paths.agentsDir(), { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
  } catch {}
  const agents: Agent[] = [];
  for (const n of names.sort()) {
    try {
      agents.push(await loadAgent(n));
    } catch {}
  }
  return agents;
}

export async function saveState(name: string, state: AgentState): Promise<void> {
  await writeJson(join(paths.meta(name), "state.json"), state);
}

export async function updateState(name: string, patch: Partial<AgentState>): Promise<AgentState> {
  const cur = (await loadAgent(name)).state;
  const next = { ...cur, ...patch };
  await saveState(name, next);
  return next;
}

export async function effectiveSettings(agent: Agent): Promise<EffectiveSettings> {
  const g = await loadSettings();
  const disabled = new Set(agent.settings.disableMcp ?? []);
  const shared = g.mcpServers.filter((s) => !disabled.has(s.name));
  return {
    backend: agent.settings.backend ?? g.backend,
    model: agent.settings.model ?? g.model,
    dailyBudgetUsd: agent.settings.dailyBudgetUsd ?? g.dailyBudgetUsd,
    workspace: agent.settings.workspace ?? agent.dir,
    mcpServers: [...shared, ...(agent.settings.mcpServers ?? [])],
  };
}
