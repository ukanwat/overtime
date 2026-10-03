import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../paths.js";
import { readJson, writeJson } from "../fsutil.js";
import { withLock } from "../store/mutex.js";
import { parseFrontMatter } from "./frontmatter.js";
import { loadSettings, type McpServerConfig } from "../settings.js";

export const FORMAT_VERSION = 1;

/** Settings an agent carries at the top of its AGENT.md. All optional; defaults come from settings.json. */
export interface AgentSettings {
  backend?: string;
  model?: string | null;
  dailyBudgetUsd?: number;
  dailyTokenBudget?: number | null;
  /** Where the work lives. Defaults to the agent's own folder. */
  workspace?: string;
  /** Extra MCP servers for this agent only. */
  mcpServers?: McpServerConfig[];
  /** Names of shared MCP servers this agent should not get. */
  disableMcp?: string[];
}

export type AgentStatus = "new" | "working" | "asleep" | "paused" | "stopped" | "error";

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
  /** The model the main session was started on; a different model means a fresh session. */
  mainSessionModel?: string | null;
  /** Fingerprints of AGENT.md and INDEX.md when the main session last ended. */
  mainSessionFiles?: { agent: string; index: string };
  /** The backend/model a "model isn't available" alert was already raised for. */
  modelIssueFor?: string;
  createdAt: string;
  lastRunAt: string | null;
  lastError: string | null;
  /** When paused by a subscription usage limit: when it resumes. */
  pausedUntil?: string | null;
  /** Consecutive failed turns, for back-off. */
  failures?: number;
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
  dailyTokenBudget: number | null;
  workspace: string;
  mcpServers: McpServerConfig[];
}

export function expandHome(p: string): string {
  return p === "~" ? (process.env.HOME ?? p) : p.startsWith("~/") ? join(process.env.HOME ?? "", p.slice(2)) : p;
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
  await writeSettingsSnapshot(name, settings);
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
  const snapshot = await readSettingsSnapshot(name);
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
  return { name, dir, settings: snapshot ?? (data as AgentSettings), identity: body, index, state };
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

/**
 * Change an agent's state. Serialised per agent. A stopped agent stays stopped: nothing but an explicit
 * start (allowStopped) can move it out of "stopped", so a turn finishing late can't undo a stop.
 */
export async function updateState(name: string, patch: Partial<AgentState>, opts: { allowStopped?: boolean } = {}): Promise<AgentState> {
  return withLock(`state:${name}`, async () => {
    const cur = (await loadAgent(name)).state;
    const p = { ...patch };
    if (cur.status === "stopped" && !opts.allowStopped && p.status && p.status !== "stopped") delete p.status;
    const next = { ...cur, ...p };
    await saveState(name, next);
    return next;
  });
}

const settingsFile = (name: string) => join(paths.meta(name), "settings.json");

/**
 * The person's settings for an agent. AGENT.md's front matter shows them, but the agent rewrites
 * AGENT.md, so the daemon keeps its own copy and that copy is what counts.
 */
export async function readSettingsSnapshot(name: string): Promise<AgentSettings | null> {
  return readJson<AgentSettings | null>(settingsFile(name), null);
}

export async function writeSettingsSnapshot(name: string, s: AgentSettings): Promise<void> {
  await writeJson(settingsFile(name), s);
}

async function frontMatterOf(name: string): Promise<{ data: AgentSettings; body: string } | null> {
  try {
    const { data, body } = parseFrontMatter(await readFile(join(paths.agent(name), "AGENT.md"), "utf8"));
    return { data: data as AgentSettings, body };
  } catch {
    return null;
  }
}

/** After a turn: make AGENT.md's settings block exactly the person's settings again. */
export async function restoreSettings(name: string): Promise<boolean> {
  const fm = await frontMatterOf(name);
  if (!fm) return false;
  const saved = await readSettingsSnapshot(name);
  if (!saved) {
    // No copy (lost or damaged): AGENT.md's block is the best record left, so keep it rather than wipe it.
    await writeSettingsSnapshot(name, fm.data ?? {});
    return false;
  }
  const snap = saved;
  if (JSON.stringify(sortKeys(fm.data as Record<string, unknown>)) === JSON.stringify(sortKeys(snap as Record<string, unknown>))) return false;
  const { stringifyFrontMatter } = await import("./frontmatter.js");
  await writeFile(join(paths.agent(name), "AGENT.md"), stringifyFrontMatter(snap as Record<string, unknown>, fm.body));
  return true;
}

/**
 * While no session is running: a changed settings block in AGENT.md is the person's edit, so adopt it.
 * A block that disappeared entirely is never adopted (that is a rewrite that dropped it); it is put back.
 */
export async function adoptSettingsEdit(name: string): Promise<boolean> {
  const fm = await frontMatterOf(name);
  if (!fm) return false;
  const snap = (await readSettingsSnapshot(name)) ?? {};
  if (!Object.keys(fm.data ?? {}).length && Object.keys(snap).length) {
    await restoreSettings(name);
    return false;
  }
  if (JSON.stringify(sortKeys(fm.data as Record<string, unknown>)) === JSON.stringify(sortKeys(snap as Record<string, unknown>))) return false;
  await writeSettingsSnapshot(name, fm.data);
  return true;
}

/** Whether the agent has been given its job yet (it rewrites the placeholder AGENT.md when it has). */
export function hasIdentity(agent: Agent): boolean {
  return !agent.identity.includes("No identity yet. This agent was just created.");
}

function sortKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

export async function effectiveSettings(agent: Agent): Promise<EffectiveSettings> {
  const g = await loadSettings();
  const disabled = new Set(agent.settings.disableMcp ?? []);
  const shared = g.mcpServers.filter((s) => !disabled.has(s.name));
  return {
    backend: agent.settings.backend ?? g.backend,
    model: agent.settings.model ?? g.model,
    dailyBudgetUsd: agent.settings.dailyBudgetUsd ?? g.dailyBudgetUsd,
    dailyTokenBudget: agent.settings.dailyTokenBudget !== undefined ? agent.settings.dailyTokenBudget : g.dailyTokenBudget,
    workspace: agent.settings.workspace ? expandHome(agent.settings.workspace) : agent.dir,
    mcpServers: [...shared, ...(agent.settings.mcpServers ?? [])],
  };
}

/** The person changed an agent's settings (from the app or the CLI): update the copy that counts and AGENT.md. */
export async function setSettings(name: string, patch: Partial<AgentSettings>): Promise<AgentSettings> {
  return withLock(`settings:${name}`, async () => {
    const cur = (await readSettingsSnapshot(name)) ?? {};
    const next: AgentSettings = { ...cur };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (v === null || v === "") delete (next as any)[k];
      else (next as any)[k] = v;
    }
    await writeSettingsSnapshot(name, next);
    await restoreSettings(name);
    return next;
  });
}
