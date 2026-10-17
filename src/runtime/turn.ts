import { join } from "node:path";
import { listSkills, skillsBlock } from "../skills.js";
import { AGENT_MARKER, recordLeftovers, sessionSpan } from "./leftovers.js";
import { home as overtimeHome, paths } from "../paths.js";
import { geminiMemoryOff, isolationEnv } from "../acp/backends.js";
import { appendJsonl, newId } from "../fsutil.js";
import { AcpSession, type SessionUpdate, type PromptResult } from "../acp/session.js";
import { effectiveSettings, loadAgent, restoreSettings, updateState, type Agent } from "../agent/agent.js";
import type { McpServerConfig } from "../settings.js";
import { INSTRUCTIONS_VERSION, workingInstructions } from "./instructions.js";
import { memoryBlock } from "../agent/memory.js";
import { sandboxAvailable } from "./sandbox.js";
import { inScope, OwnWrites, writeLayers } from "./write-scope.js";
import { answer } from "./permissions.js";
import { clearLimit, confirmLimit, recordTurnUsage, rejectedLimits, warnedLimits, writeLimit, type TurnUsage } from "./usage.js";
import { classify } from "./errors.js";

/** reflect: a short session Overtime runs now and then to keep an agent's memory/ current. */
export type SessionKind = "main" | "chat" | "helper" | "reflect";

export interface TurnOptions {
  /** The id for this run's log and usage row (the daemon passes its own, so all records of one turn match). */
  runId?: string;
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
  /** Switch a continued session to the chosen model (the person changed it); a fresh one always gets it. */
  switchModel?: boolean;
  /** Hard limit for the whole turn. On expiry the turn is cancelled, then the backend is killed. */
  timeoutMs?: number;
  /** Lets the caller cancel a running turn (daemon shutdown, agent stopped, helper cancelled). */
  signal?: AbortSignal;
  /** Extra lines for the header of this turn (e.g. today's spend), after the time and reason. */
  header?: string;
  /** Replace the default preamble for a fresh session (helpers and chats get their own). */
  preamble?: string;
  /** Claude Code tools this session doesn't get, on top of the ones no Overtime session gets. */
  disallowedTools?: string[];
  /**
   * The only folders this session may change (a reflect pass: memory/). Everything else stays as it was,
   * on every backend: see runtime/write-scope.ts.
   */
  writable?: string[];
  /** The agent's own MCP servers (mcp.json, shared and the person's). Off: only extraMcp. */
  agentServers?: boolean;
  /**
   * Whether a usage limit this turn runs into is recorded for its backend and model (pausing every agent
   * on it). Off for background housekeeping (a reflect pass): its limit just ends the turn.
   */
  recordLimits?: boolean;
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
  /** Set when the backend wouldn't switch to the chosen model; the turn ran on its default. */
  modelIssue?: string;
  /** The backend compacted the session's context during this turn (reported structurally, by Claude). */
  compacted?: boolean;
}

/** The backend reported a subscription usage limit; nothing failed, the agent should pause until the reset. */
export class UsageLimitError extends Error {
  constructor(
    readonly backend: string,
    readonly resetsAt: Date | null,
    /** The model the turn ran on: limits are per model. */
    readonly model: string | null = null,
  ) {
    super(`${backend} usage limit reached${resetsAt ? `; resets ${resetsAt.toISOString()}` : ""}`);
  }
}

/** A turn that didn't finish: cancelled, aborted or past its deadline. Its work must not count as done. */
export class TurnIncompleteError extends Error {
  /** Whether the agent was sent this turn's prompt before it stopped (so it saw what it was handed). */
  constructor(message: string, readonly promptSent = false) {
    super(message);
  }
}

/** Whether the agent was sent the prompt of the turn that ended with this error (see runTurn). */
export function promptWasSent(e: unknown): boolean {
  return !!(e as any)?.promptSent;
}

/** The context every fresh session starts with: how to work, who it is, and where things are. */
export function sessionPreamble(agent: Agent, kind: "main" | "chat" = "main"): string {
  const parts = [
    workingInstructions(agent.name, kind),
    `# Your folder\n\n${agent.dir}\n\nAGENT.md and INDEX.md live there. Everything else in it is yours: clone, download and organise whatever the work needs.`,
    `# AGENT.md (who you are)\n\n${agent.identity.trim() || "(empty)"}`,
    `# INDEX.md (your map of your folder)\n\n${agent.index.trim() || "(You haven't written INDEX.md yet. Create it once you have files worth finding again.)"}`,
    memoryBlock(agent.dir, agent.memory),
    skillsBlock(agent.dir),
  ].filter(Boolean);
  return parts.join("\n\n---\n\n");
}

const KILL_GRACE_MS = 20_000;

/**
 * Claude reports compacting a session's context as a tool call of its own, named "compact" (the ACP
 * adapter's form for clients without compaction updates). Other backends don't say.
 */
export function isCompaction(u: SessionUpdate): boolean {
  const x = u as any;
  return (x.sessionUpdate === "tool_call" || x.sessionUpdate === "tool_call_update") && x._meta?.claudeCode?.toolName === "compact" && x.status === "completed";
}

/** Per agent: how many of its sessions are running, and since when, for cleaning up what they leave behind. */
const activeSessions = new Map<string, { count: number; since: number; roots: Set<string> }>();

export async function runTurn(o: TurnOptions): Promise<TurnResult> {
  if (o.signal?.aborted) throw new TurnIncompleteError("cancelled before it started");
  const agent = await loadAgent(o.agent);
  const base = await effectiveSettings(agent);
  const eff = { ...base, backend: o.backend ?? base.backend, model: o.model !== undefined ? o.model : base.model, workspace: o.cwd ?? base.workspace };
  const runId = o.runId ?? newId(o.kind);
  const runLog = join(paths.meta(agent.name), "runs", `${runId}.jsonl`);
  const record = (event: string, data: unknown) => appendJsonl(runLog, { t: new Date().toISOString(), event, data }).catch(() => {});
  const scope = { roots: [agent.dir, base.workspace, eff.workspace] };
  // A session that may change only some folders: what its own tools change elsewhere is put back after.
  // The agent's own files and the skills it sees are copied first, so even a write the backend makes
  // before Overtime hears of it is put back (with no sandbox to stop it, on Linux without bubblewrap).
  const keep = [...["AGENT.md", "INDEX.md", "mcp.json"].map((f) => join(agent.dir, f)), ...listSkills(agent.dir).filter((k) => k.source !== "built-in").map((k) => k.file)];
  const own = o.writable ? new OwnWrites(o.writable, eff.workspace, keep) : null;

  let reply = "";
  let sessionCost: number | null = null;
  let firstCost: number | null = null;
  let afterTool = false;
  let promptSent = false;
  let context: { used: number; size: number } | null = null;
  let limitRejected: { resetsAt: Date | null } | null = null;
  let stopped: string | null = null;
  let session: AcpSession | null = null;
  let recorded = false;
  let modelIssue: string | undefined;
  let compacted = false;

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

  // Count this session in: what its sessions leave running is recorded once the agent's last session ends.
  const act = activeSessions.get(agent.name) ?? { count: 0, since: Date.now(), roots: new Set<string>() };
  if (act.count === 0) act.since = Date.now();
  act.count++;
  for (const r of scope.roots) act.roots.add(r);
  activeSessions.set(agent.name, act);
  // And noted for other agents: a folder two agents work in at once is no proof of whose a process is.
  const endSpan = sessionSpan(agent.name, scope.roots);

  try {
    // Gemini's memory is off through project settings: only in the agent's own folder (and its helpers'),
    // never written into a workspace of the person's.
    if (eff.backend === "gemini" && (eff.workspace === agent.dir || eff.workspace.startsWith(agent.dir + "/"))) await geminiMemoryOff(eff.workspace).catch(() => {});
    session = await AcpSession.open({
      backend: eff.backend,
      cwd: eff.workspace,
      protect: base.protect,
      disallowedTools: o.disallowedTools,
      hide: base.hidden,
      writeLayers: o.writable && sandboxAvailable().ok ? writeLayers([...o.writable, join(paths.meta(agent.name), "codex-home")], { overtimeHome: overtimeHome(), agentDir: agent.dir, workspace: eff.workspace }) : undefined,
      // Marks the backend and everything it starts as this agent's (see runtime/leftovers.ts).
      env: { [AGENT_MARKER]: agent.name, ...(await isolationEnv(eff.backend, paths.meta(agent.name))) },
      mcpServers: [...(o.agentServers === false ? [] : eff.mcpServers), ...(o.extraMcp ?? [])],
      onUpdate: (u) => {
        if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
          // Text from separate messages (with tool calls between) becomes separate paragraphs, not one run-on line.
          if (afterTool && reply && !/\s$/.test(reply)) reply += "\n\n";
          afterTool = false;
          reply += u.content.text;
        }
        if (u.sessionUpdate === "tool_call") afterTool = true;
        if (isCompaction(u)) compacted = true;
        own?.see(u);
        if (u.sessionUpdate === "usage_update") {
          const uu = u as any;
          if (typeof uu.used === "number" && typeof uu.size === "number") context = { used: uu.used, size: uu.size };
          if (uu.cost && typeof uu.cost.amount === "number" && (uu.cost.currency ?? "USD") === "USD") {
            if (firstCost == null) firstCost = uu.cost.amount;
            sessionCost = uu.cost.amount;
          }
          const rl = uu._meta?.["_claude/rateLimit"];
          if (rl && typeof rl.status === "string") {
            if (o.recordLimits !== false) void writeLimit({ backend: eff.backend, model: eff.model ?? null, status: rl.status, rateLimitType: rl.rateLimitType, utilization: rl.utilization, resetsAt: rl.resetsAt, updatedAt: new Date().toISOString() });
            if (rl.status === "rejected") limitRejected = { resetsAt: rl.resetsAt ? new Date(rl.resetsAt * 1000) : null };
          }
        }
        void record("update", u);
        o.onUpdate?.(u);
      },
      // Every request is allowed: Overtime's own command check (judge, in permissions.ts) is off for now.
      // What the person protects stays read-only, enforced by the operating system (runtime/sandbox.ts).
      // A session that may change only some folders is refused the rest, on backends that ask first.
      onPermission: (req) => {
        const d = o.writable ? inScope(req, o.writable, eff.workspace) : { allowed: true, reason: "allowed" };
        void record("permission", { title: (req.toolCall as any)?.title, input: (req.toolCall as any)?.rawInput, allowed: d.allowed, reason: d.reason });
        return answer(req, d);
      },
      // Backend output goes to this run's log (each backend has its own chatter); when a backend fails,
      // its last lines come with the error itself.
      onStderr: (line) => void record("stderr", line),
    });
    if (stopped) throw new TurnIncompleteError(stopped);

    let fresh = true;
    if (o.resumeSessionId) fresh = !(await session.loadSession(o.resumeSessionId));
    if (fresh) await session.newSession();
    // A fresh session gets the chosen model; a continued one too when the person changed it.
    if (fresh || o.switchModel) {
      if (eff.model && !(await session.setModel(eff.model))) {
        const offered = session.availableModels().map((m) => m.id);
        modelIssue = `${eff.backend} wouldn't switch to the model "${eff.model}", so this ran on its default.${offered.length ? ` It offers: ${offered.join(", ")}.` : ""}`;
        o.log?.(`[${agent.name}/${o.kind}] ${modelIssue}`);
        void record("model", { wanted: eff.model, ok: false, offered });
      }
    }
    if (stopped) throw new TurnIncompleteError(stopped);
    o.onSession?.(session.sessionId, fresh);
    const now = new Date();
    // Protected paths go in every turn's header, so a change reaches a session that is being continued.
    const prot = base.protect.length ? `\nRead-only for you (the person's protected paths): ${base.protect.join(", ")}. If your work needs a change there, ask.` : "";
    // Like protected paths, the workspace is restated every turn, so a change reaches a continued session.
    const ws = o.kind !== "helper" && base.workspace !== agent.dir ? `\nYour workspace (where the work lives): ${base.workspace}` : "";
    // Skill names every turn (descriptions are in the session's opening), so one written mid-session shows up.
    const names = listSkills(agent.dir).map((k) => k.name);
    const sk = names.length ? `\nYour skills (load with skill): ${names.join(", ")}` : "";
    const header = `Time now: ${now.toISOString()} (${now.toString()}).\nWhy you are awake: ${o.reason}${o.header ? `\n${o.header}` : ""}${ws}${prot}${sk}`;
    const body = typeof o.text === "function" ? o.text(fresh) : o.text;
    const preamble = o.preamble ?? sessionPreamble(agent);
    const prompt = fresh ? `${preamble}\n\n---\n\n${header}\n\n${body}` : `${header}\n\n${body}`;
    await record("start", { kind: o.kind, backend: eff.backend, model: eff.model, sessionId: session.sessionId, fresh, reason: o.reason, sandboxed: session.sandboxed, instructionsVersion: INSTRUCTIONS_VERSION });
    // Every byte Overtime sends is kept, so you can always see exactly what an agent was told.
    await record("prompt", { text: prompt });

    let res: PromptResult;
    try {
      promptSent = true;
      res = await session.prompt(prompt);
    } catch (e) {
      const lim = limitRejected as { resetsAt: Date | null } | null;
      if (lim) throw new UsageLimitError(eff.backend, lim.resetsAt, eff.model ?? null);
      if (stopped) throw new TurnIncompleteError(stopped, promptSent);
      // A usage limit, whichever backend says so: noted for the backend and model, so every agent on
      // that model waits (see blockedUntil), and reported as a limit rather than a failure.
      // Claude reports a used-up subscription limit with the same error kind as a passing rate limit.
      // What tells them apart is the limit status the backend itself last reported for this model
      // (its structured rate-limit updates, kept in limits.json): rejected, with a reset still ahead.
      if (classify(e) === "transient") {
        const resets = (await rejectedLimits(eff.backend, eff.model)).map((l) => (l.resetsAt ?? 0) * 1000).filter((t) => t > Date.now());
        if (resets.length) {
          // Still over it: trusted for another while, so other agents on this model don't try it meanwhile.
          if (o.recordLimits !== false) await confirmLimit(eff.backend, eff.model);
          throw new UsageLimitError(eff.backend, new Date(Math.max(...resets)), eff.model ?? null);
        }
        // No "rejected" report, but the backend last warned that a limit of this model was nearly used up,
        // and it hasn't reset: a rate limit now is that limit running out (Claude doesn't always send the
        // rejected report, e.g. when it already knows before the request goes out). The window nearest its
        // limit (by its reported use, else the soonest to reset) is recorded as used up, so other agents on
        // this model wait too; it's tried again every 15 minutes, and lifts as soon as a turn gets through.
        const warned = (e as any)?.data?.errorKind === "rate_limit" ? await warnedLimits(eff.backend, eff.model) : [];
        if (warned.length) {
          const w = warned.sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0) || (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity))[0];
          if (o.recordLimits !== false) await writeLimit({ ...w, status: "rejected", updatedAt: new Date().toISOString() });
          throw new UsageLimitError(eff.backend, w.resetsAt ? new Date(w.resetsAt * 1000) : null, eff.model ?? null);
        }
      }
      if (classify(e) === "limit") {
        if (o.recordLimits !== false) await writeLimit({ backend: eff.backend, model: eff.model ?? null, status: "rejected", updatedAt: new Date().toISOString() });
        throw new UsageLimitError(eff.backend, null, eff.model ?? null);
      }
      throw e;
    }
    await record("end", { stopReason: res.stopReason, usage: res.usage ?? null, sessionCost, context });
    const u = res.usage;
    // A cancelled turn the backend reported nothing for has nothing to count: no row, rather than an empty one.
    if ((stopped || res.stopReason === "cancelled") && sessionCost == null && !u) throw new TurnIncompleteError(stopped ?? "the backend cancelled the turn", true);
    const usage2 = await recordTurnUsage(agent.name, {
      runId,
      kind: o.kind,
      backend: eff.backend,
      sessionId: session.sessionId,
      tokens: u ? { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cacheRead: u.cachedReadTokens ?? 0, cacheWrite: u.cachedWriteTokens ?? 0, total: u.totalTokens ?? 0 } : null,
      sessionCostUsd: sessionCost,
      firstCostUsd: firstCost,
      context,
    });
    recorded = true;
    if (limitRejected) throw new UsageLimitError(eff.backend, (limitRejected as { resetsAt: Date | null }).resetsAt, eff.model ?? null);
    // It got through: a limit recorded for this backend and model is over, for every agent on that model.
    await clearLimit(eff.backend, eff.model);
    if (o.kind === "main") await updateState(agent.name, { mainSessionId: session.sessionId, mainSessionBackend: eff.backend, mainSessionModel: eff.model ?? null, lastRunAt: new Date().toISOString() });
    if (stopped || res.stopReason === "cancelled") throw new TurnIncompleteError(stopped ?? "the backend cancelled the turn", true);
    return { runId, sessionId: session.sessionId, fresh, reply: reply.trim(), stopReason: res.stopReason, usage: res.usage ?? null, backend: eff.backend, usage2, context, modelIssue, compacted };
  } catch (e: any) {
    await record("error", { message: String(e?.message ?? e) });
    // Whatever went wrong, the caller learns whether the agent was handed this turn's prompt.
    if (promptSent && e && typeof e === "object" && !e.promptSent) e.promptSent = true;
    // A turn that failed or was killed still spent money: count what the backend reported so far.
    if (!recorded && session?.sessionId && sessionCost != null) {
      await recordTurnUsage(agent.name, { runId, kind: o.kind, backend: eff.backend, sessionId: session.sessionId, tokens: null, sessionCostUsd: sessionCost, firstCostUsd: firstCost, context, incomplete: true }).catch(() => {});
    }
    throw e;
  } finally {
    if (deadline) clearTimeout(deadline);
    if (killTimer) clearTimeout(killTimer);
    o.signal?.removeEventListener("abort", onAbort);
    if (session) await session.close();
    if (own) {
      const { restored, kept, uncopied } = await own.undo().catch(() => ({ restored: [] as string[], kept: [] as string[], uncopied: [] as string[] }));
      for (const f of restored) o.log?.(`[${agent.name}/${o.kind}] changed ${f}, which it may not change; put it back`);
      for (const f of kept) o.log?.(`[${agent.name}/${o.kind}] changed ${f}, which it may not change, and it has been changed again since; left as it is`);
      for (const f of uncopied) o.log?.(`[${agent.name}/${o.kind}] may have changed ${f}, which it may not change, before Overtime could keep a copy; left as it is`);
      if (restored.length || kept.length || uncopied.length) void record("outside", { restored, kept, uncopied });
    }
    // A sign-in the backend refreshed during the session goes back to the person's own.
    await isolationEnv(eff.backend, paths.meta(agent.name)).catch(() => {});
    endSpan();
    act.count--;
    if (act.count === 0) {
      activeSessions.delete(agent.name);
      // Kept running (the agent decides), but recorded so it and the person can see and control them.
      const fresh = await recordLeftovers(agent.name, act.since, [...act.roots]).catch(() => []);
      if (fresh.length) o.log?.(`[${agent.name}] keeps running in the background: ${fresh.map((b) => `${b.pid} ${b.command.slice(0, 80)}`).join("; ")}`);
    }
    // The settings block only shows the person's settings: whatever changed it during the turn is undone.
    if (o.kind !== "helper" && (await restoreSettings(agent.name))) o.log?.(`[${agent.name}] put back its settings in AGENT.md (they change only from the app or overtime set)`);
  }
}
