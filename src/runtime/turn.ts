import { join } from "node:path";
import { paths } from "../paths.js";
import { appendJsonl, newId } from "../fsutil.js";
import { AcpSession, type SessionUpdate, type PromptResult } from "../acp/session.js";
import { adoptSettingsEdit, effectiveSettings, loadAgent, restoreSettings, updateState, type Agent } from "../agent/agent.js";
import type { McpServerConfig } from "../settings.js";
import { INSTRUCTIONS_VERSION, workingInstructions } from "./instructions.js";
import { answer, judge } from "./permissions.js";
import { recordTurnUsage, writeLimit, type TurnUsage } from "./usage.js";

export type SessionKind = "main" | "chat" | "helper";

export interface TurnOptions {
  agent: string;
  kind: SessionKind;
  /** What happened that started this turn, in plain words (shown to the agent). */
  reason: string;
  /** The message or task for this turn. A function gets told whether the session is fresh (no earlier context). */
  text: string | ((fresh: boolean) => string);
  /** Continue this ACP session if the backend allows; otherwise a fresh one is started. */
  resumeSessionId?: string | null;
  /** Extra MCP servers for this session only (Overtime's own tools server is passed here). */
  extraMcp?: McpServerConfig[];
  /** Overrides for helpers: their own folder, backend and model. */
  cwd?: string;
  backend?: string;
  model?: string | null;
  /** Hard limit for the whole turn. On expiry the turn is cancelled, then the backend is killed. */
  timeoutMs?: number;
  /** Lets the caller cancel a running turn (daemon shutdown, agent stopped, helper cancelled). */
  signal?: AbortSignal;
  /** Extra lines for the header of this turn (e.g. today's spend), after the time and reason. */
  header?: string;
  /** Replace the default preamble for a fresh session (helpers and chats get their own). */
  preamble?: string;
  /** Live view of everything the agent does in this turn. */
  onUpdate?: (u: SessionUpdate) => void;
  /** Called once the session id is known (fresh or resumed). */
  onSession?: (sessionId: string, fresh: boolean) => void;
  log?: (line: string) => void;
}

export interface TurnResult {
  runId: string;
  sessionId: string;
  fresh: boolean;
  reply: string;
  stopReason: PromptResult["stopReason"];
  usage: PromptResult["usage"] | null;
  backend: string;
  usage2: TurnUsage | null;
  context: { used: number; size: number } | null;
}

/** The backend reported a subscription usage limit; nothing failed, the agent should pause until the reset. */
export class UsageLimitError extends Error {
  constructor(readonly backend: string, readonly resetsAt: Date | null) {
    super(`${backend} usage limit reached${resetsAt ? `; resets ${resetsAt.toISOString()}` : ""}`);
  }
}

/** A turn that didn't finish: cancelled, aborted or past its deadline. Its work must not count as done. */
export class TurnIncompleteError extends Error {}

/** The context every fresh session starts with: how to work, who it is, and where things are. */
export function sessionPreamble(agent: Agent): string {
  const parts = [
    workingInstructions(agent.name),
    `# Your folder\n\n${agent.dir}\n\nAGENT.md and INDEX.md live there. Everything else in it is yours to organise.`,
    `# AGENT.md (who you are)\n\n${agent.identity.trim() || "(empty)"}`,
    `# INDEX.md (your map of your folder)\n\n${agent.index.trim() || "(You haven't written INDEX.md yet. Create it once you have files worth finding again.)"}`,
  ];
  return parts.join("\n\n---\n\n");
}

const KILL_GRACE_MS = 20_000;

/** When an agent's own session last wrote (or may have written) its AGENT.md, per agent. */
const agentMdTouched = new Map<string, number>();
/** Sessions still running that wrote AGENT.md: until they end, no change to it can be the person's. */
const agentMdWriters = new Map<string, Set<string>>();

/** Whether a tool call from the agent writes, or may write, its AGENT.md. */
export function touchesAgentMd(u: SessionUpdate, agentDir: string): boolean {
  if (u.sessionUpdate !== "tool_call" && u.sessionUpdate !== "tool_call_update") return false;
  const tc = u as any;
  if (tc.kind === "read" || tc.kind === "search" || tc.kind === "fetch" || tc.kind === "think") return false;
  const target = `${agentDir.replace(/\/+$/, "")}/AGENT.md`;
  const paths = [...(tc.locations ?? []).map((l: any) => l?.path), tc.rawInput?.file_path, tc.rawInput?.path, tc.rawInput?.notebook_path].filter((p) => typeof p === "string");
  if (paths.some((p: string) => p === target || p === "AGENT.md" || p.endsWith("/AGENT.md"))) return true;
  const cmd = tc.rawInput?.command;
  return typeof cmd === "string" && cmd.includes("AGENT.md");
}

export async function runTurn(o: TurnOptions): Promise<TurnResult> {
  if (o.signal?.aborted) throw new TurnIncompleteError("cancelled before it started");
  const agent = await loadAgent(o.agent);
  const base = await effectiveSettings(agent);
  const eff = { ...base, backend: o.backend ?? base.backend, model: o.model !== undefined ? o.model : base.model, workspace: o.cwd ?? base.workspace };
  const runId = newId(o.kind);
  const runLog = join(paths.meta(agent.name), "runs", `${runId}.jsonl`);
  const record = (event: string, data: unknown) => appendJsonl(runLog, { t: new Date().toISOString(), event, data }).catch(() => {});
  const scope = { roots: [agent.dir, base.workspace, eff.workspace] };
  const startedAt = Date.now();

  let reply = "";
  let sessionCost: number | null = null;
  let context: { used: number; size: number } | null = null;
  let limitRejected: { resetsAt: Date | null } | null = null;
  let stopped: string | null = null;
  let session: AcpSession | null = null;

  // One deadline and one cancel path for the whole turn, including starting the backend.
  // Cancel politely first; if the backend ignores it, kill it, so a turn can never hang.
  let killTimer: NodeJS.Timeout | undefined;
  const stop = (why: string) => {
    if (stopped) return;
    stopped = why;
    void record("stopped", { why });
    if (session) void session.cancel();
    killTimer = setTimeout(() => void session?.close(), KILL_GRACE_MS);
  };
  const deadline = o.timeoutMs ? setTimeout(() => stop(`ran past its ${Math.round(o.timeoutMs! / 60000)}-minute limit`), o.timeoutMs) : undefined;
  const onAbort = () => stop("cancelled");
  o.signal?.addEventListener("abort", onAbort);

  try {
    session = await AcpSession.open({
      backend: eff.backend,
      cwd: eff.workspace,
      mcpServers: [...eff.mcpServers, ...(o.extraMcp ?? [])],
      onUpdate: (u) => {
        if (o.kind !== "helper" && touchesAgentMd(u, agent.dir)) {
          agentMdTouched.set(agent.name, Date.now());
          if (!agentMdWriters.has(agent.name)) agentMdWriters.set(agent.name, new Set());
          agentMdWriters.get(agent.name)!.add(runId);
        }
        if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") reply += u.content.text;
        if (u.sessionUpdate === "usage_update") {
          const uu = u as any;
          if (typeof uu.used === "number" && typeof uu.size === "number") context = { used: uu.used, size: uu.size };
          if (uu.cost && typeof uu.cost.amount === "number" && (uu.cost.currency ?? "USD") === "USD") sessionCost = uu.cost.amount;
          const rl = uu._meta?.["_claude/rateLimit"];
          if (rl && typeof rl.status === "string") {
            void writeLimit({ backend: eff.backend, status: rl.status, rateLimitType: rl.rateLimitType, utilization: rl.utilization, resetsAt: rl.resetsAt, updatedAt: new Date().toISOString() });
            if (rl.status === "rejected") limitRejected = { resetsAt: rl.resetsAt ? new Date(rl.resetsAt * 1000) : null };
          }
        }
        void record("update", u);
        o.onUpdate?.(u);
      },
      onPermission: (req) => {
        const d = judge(req, scope, eff.workspace);
        void record("permission", { title: (req.toolCall as any)?.title, input: (req.toolCall as any)?.rawInput, allowed: d.allowed, reason: d.reason });
        if (!d.allowed) o.log?.(`[${agent.name}/${o.kind}] declined: ${d.reason}`);
        return answer(req, d);
      },
      onStderr: (line) => o.log?.(`[${agent.name}/${o.kind}] ${line}`),
    });
    if (stopped) throw new TurnIncompleteError(stopped);

    let fresh = true;
    if (o.resumeSessionId) fresh = !(await session.loadSession(o.resumeSessionId));
    if (fresh) {
      await session.newSession();
      if (eff.model) await session.setModel(eff.model);
    }
    if (stopped) throw new TurnIncompleteError(stopped);
    o.onSession?.(session.sessionId, fresh);
    const now = new Date();
    const header = `Time now: ${now.toISOString()} (${now.toString()}).\nWhy you are awake: ${o.reason}${o.header ? `\n${o.header}` : ""}`;
    const body = typeof o.text === "function" ? o.text(fresh) : o.text;
    const prompt = fresh ? `${o.preamble ?? sessionPreamble(agent)}\n\n---\n\n${header}\n\n${body}` : `${header}\n\n${body}`;
    await record("start", { kind: o.kind, backend: eff.backend, model: eff.model, sessionId: session.sessionId, fresh, reason: o.reason, instructionsVersion: INSTRUCTIONS_VERSION });
    // Every byte Overtime sends is kept, so you can always see exactly what an agent was told.
    await record("prompt", { text: prompt });

    let res: PromptResult;
    try {
      res = await session.prompt(prompt);
    } catch (e) {
      const lim = limitRejected as { resetsAt: Date | null } | null;
      if (lim) throw new UsageLimitError(eff.backend, lim.resetsAt);
      if (stopped) throw new TurnIncompleteError(stopped);
      throw e;
    }
    await record("end", { stopReason: res.stopReason, usage: res.usage ?? null, sessionCost, context });
    const u = res.usage;
    const usage2 = await recordTurnUsage(agent.name, {
      runId,
      kind: o.kind,
      backend: eff.backend,
      sessionId: session.sessionId,
      tokens: u ? { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cacheRead: u.cachedReadTokens ?? 0, cacheWrite: u.cachedWriteTokens ?? 0, total: u.totalTokens ?? 0 } : null,
      sessionCostUsd: sessionCost,
      context,
    });
    if (limitRejected) throw new UsageLimitError(eff.backend, (limitRejected as { resetsAt: Date | null }).resetsAt);
    if (o.kind === "main") await updateState(agent.name, { mainSessionId: session.sessionId, mainSessionBackend: eff.backend, lastRunAt: new Date().toISOString() });
    if (stopped || res.stopReason === "cancelled") throw new TurnIncompleteError(stopped ?? "the backend cancelled the turn");
    return { runId, sessionId: session.sessionId, fresh, reply: reply.trim(), stopReason: res.stopReason, usage: res.usage ?? null, backend: eff.backend, usage2, context };
  } catch (e: any) {
    await record("error", { message: String(e?.message ?? e) });
    throw e;
  } finally {
    if (deadline) clearTimeout(deadline);
    if (killTimer) clearTimeout(killTimer);
    o.signal?.removeEventListener("abort", onAbort);
    if (session) await session.close();
    // The settings block is the person's. If an agent session wrote AGENT.md since this turn began, a
    // changed block is the agent's doing and is put back; if none did, the change is the person's edit.
    if (o.kind !== "helper") {
      const writers = agentMdWriters.get(agent.name);
      writers?.delete(runId);
      if ((agentMdTouched.get(agent.name) ?? 0) >= startedAt || writers?.size) {
        if (await restoreSettings(agent.name)) o.log?.(`[${agent.name}] put back the person's settings in AGENT.md after the agent's rewrite`);
      } else if (await adoptSettingsEdit(agent.name)) o.log?.(`[${agent.name}] adopted the settings you edited in AGENT.md`);
    }
  }
}
