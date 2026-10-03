import { join } from "node:path";
import { paths } from "../paths.js";
import { appendJsonl, newId } from "../fsutil.js";
import { AcpSession, type SessionUpdate, type PromptResult } from "../acp/session.js";
import { effectiveSettings, loadAgent, protectSettings, updateState, type Agent } from "../agent/agent.js";
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
  /** The message or task for this turn. */
  text: string;
  /** Continue this ACP session if the backend allows; otherwise a fresh one is started. */
  resumeSessionId?: string | null;
  /** Extra MCP servers for this session only (Overtime's own tools server is passed here). */
  extraMcp?: McpServerConfig[];
  /** Overrides for helpers: their own folder, backend and model. */
  cwd?: string;
  backend?: string;
  model?: string | null;
  /** Cancel the turn after this long. */
  timeoutMs?: number;
  /** Lets the caller cancel a running turn (e.g. the daemon shutting down). */
  signal?: AbortSignal;
  /** Extra lines for the header of this turn (e.g. today's spend), after the time and reason. */
  header?: string;
  /** Replace the default preamble for a fresh session (helpers get a different one). */
  preamble?: string;
  /** Live view of everything the agent does in this turn. */
  onUpdate?: (u: SessionUpdate) => void;
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

export async function runTurn(o: TurnOptions): Promise<TurnResult> {
  const agent = await loadAgent(o.agent);
  const settingsBefore = { ...agent.settings };
  const base = await effectiveSettings(agent);
  const eff = { ...base, backend: o.backend ?? base.backend, model: o.model !== undefined ? o.model : base.model, workspace: o.cwd ?? base.workspace };
  const runId = newId(o.kind);
  const runLog = join(paths.meta(agent.name), "runs", `${runId}.jsonl`);
  const record = (event: string, data: unknown) => appendJsonl(runLog, { t: new Date().toISOString(), event, data });

  let reply = "";
  let sessionCost: number | null = null;
  let context: { used: number; size: number } | null = null;
  let limitRejected: { resetsAt: Date | null } | null = null;
  const session = await AcpSession.open({
    backend: eff.backend,
    cwd: eff.workspace,
    mcpServers: [...eff.mcpServers, ...(o.extraMcp ?? [])],
    onUpdate: (u) => {
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
      const d = judge(req);
      void record("permission", { title: (req.toolCall as any)?.title, allowed: d.allowed, reason: d.reason });
      return answer(req, d);
    },
    onStderr: (line) => o.log?.(`[${agent.name}/${o.kind}] ${line}`),
  });

  try {
    let fresh = true;
    if (o.resumeSessionId) fresh = !(await session.loadSession(o.resumeSessionId));
    if (fresh) {
      await session.newSession();
      if (eff.model) await session.setModel(eff.model);
    }
    const now = new Date();
    const header = `Time now: ${now.toISOString()} (${now.toString()}).\nWhy you are awake: ${o.reason}${o.header ? `\n${o.header}` : ""}`;
    const prompt = fresh ? `${o.preamble ?? sessionPreamble(agent)}\n\n---\n\n${header}\n\n${o.text}` : `${header}\n\n${o.text}`;
    await record("start", { kind: o.kind, backend: eff.backend, model: eff.model, sessionId: session.sessionId, fresh, reason: o.reason, instructionsVersion: INSTRUCTIONS_VERSION });
    // Every byte Overtime sends is kept, so you can always see exactly what an agent was told.
    await record("prompt", { text: prompt });
    let res: PromptResult;
    let timedOut = false;
    const timer = o.timeoutMs ? setTimeout(() => { timedOut = true; void session.cancel(); }, o.timeoutMs) : null;
    const onAbort = () => void session.cancel();
    o.signal?.addEventListener("abort", onAbort);
    try {
      res = await session.prompt(prompt);
      if (timedOut) await record("timeout", { afterMs: o.timeoutMs });
    } catch (e) {
      const lim = limitRejected as { resetsAt: Date | null } | null;
      if (lim) throw new UsageLimitError(eff.backend, lim.resetsAt);
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
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
    if (o.kind === "main") {
      await updateState(agent.name, { mainSessionId: session.sessionId, mainSessionBackend: eff.backend, lastRunAt: new Date().toISOString(), lastError: null });
    }
    return { runId, sessionId: session.sessionId, fresh, reply: reply.trim(), stopReason: res.stopReason, usage: res.usage ?? null, backend: eff.backend, usage2, context };
  } catch (e: any) {
    await record("error", { message: String(e?.message ?? e) });
    if (o.kind === "main") await updateState(agent.name, { lastError: String(e?.message ?? e) });
    throw e;
  } finally {
    await session.close();
    if (await protectSettings(agent.name, settingsBefore)) o.log?.(`[${agent.name}] restored AGENT.md settings after the agent's rewrite`);
  }
}
