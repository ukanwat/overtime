import { join } from "node:path";
import { listSkills, skillsBlock } from "../skills.js";
import { AGENT_MARKER, recordLeftovers } from "./leftovers.js";
import { paths } from "../paths.js";
import { isolationEnv } from "../acp/backends.js";
import { appendJsonl, newId } from "../fsutil.js";
import { AcpSession, type SessionUpdate, type PromptResult } from "../acp/session.js";
import { adoptSettingsEdit, effectiveSettings, loadAgent, restoreSettings, updateState, type Agent } from "../agent/agent.js";
import type { McpServerConfig } from "../settings.js";
import { INSTRUCTIONS_VERSION, workingInstructions } from "./instructions.js";
import { answer } from "./permissions.js";
import { clearLimit, recordTurnUsage, writeLimit, type TurnUsage } from "./usage.js";
import { classify } from "./errors.js";

export type SessionKind = "main" | "chat" | "helper";

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
}

/** The backend reported a subscription usage limit; nothing failed, the agent should pause until the reset. */
export class UsageLimitError extends Error {
  constructor(readonly backend: string, readonly resetsAt: Date | null) {
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

/** The context every fresh session starts with: how to work, who it is, and where things are. */
export function sessionPreamble(agent: Agent, kind: "main" | "chat" = "main"): string {
  const parts = [
    workingInstructions(agent.name, kind),
    `# Your folder\n\n${agent.dir}\n\nAGENT.md and INDEX.md live there. Everything else in it is yours to organise.`,
    `# AGENT.md (who you are)\n\n${agent.identity.trim() || "(empty)"}`,
    `# INDEX.md (your map of your folder)\n\n${agent.index.trim() || "(You haven't written INDEX.md yet. Create it once you have files worth finding again.)"}`,
    skillsBlock(agent.dir),
  ].filter(Boolean);
  return parts.join("\n\n---\n\n");
}

const KILL_GRACE_MS = 20_000;

/** Per agent: how many of its sessions are running, and since when, for cleaning up what they leave behind. */
const activeSessions = new Map<string, { count: number; since: number; roots: Set<string> }>();



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
  // The command, however the backend sends it: a string, a list of arguments, or only in the title.
  const cmd = tc.rawInput?.command ?? tc.rawInput?.cmd;
  const text = typeof cmd === "string" ? cmd : Array.isArray(cmd) ? cmd.join(" ") : tc.kind === "execute" && typeof tc.title === "string" ? tc.title : "";
  return text.includes("AGENT.md");
}

export async function runTurn(o: TurnOptions): Promise<TurnResult> {
  if (o.signal?.aborted) throw new TurnIncompleteError("cancelled before it started");
  const agent = await loadAgent(o.agent);
  const base = await effectiveSettings(agent);
  const eff = { ...base, backend: o.backend ?? base.backend, model: o.model !== undefined ? o.model : base.model, workspace: o.cwd ?? base.workspace };
  const runId = o.runId ?? newId(o.kind);
  const runLog = join(paths.meta(agent.name), "runs", `${runId}.jsonl`);
  const record = (event: string, data: unknown) => appendJsonl(runLog, { t: new Date().toISOString(), event, data }).catch(() => {});
  const scope = { roots: [agent.dir, base.workspace, eff.workspace] };
  const startedAt = Date.now();

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

  try {
    session = await AcpSession.open({
      backend: eff.backend,
      cwd: eff.workspace,
      protect: base.protect,
      // Marks the backend and everything it starts as this agent's (see runtime/leftovers.ts).
      env: { [AGENT_MARKER]: agent.name, ...(await isolationEnv(eff.backend, paths.meta(agent.name))) },
      mcpServers: [...eff.mcpServers, ...(o.extraMcp ?? [])],
      onUpdate: (u) => {
        if (o.kind !== "helper" && touchesAgentMd(u, agent.dir)) {
          agentMdTouched.set(agent.name, Date.now());
          if (!agentMdWriters.has(agent.name)) agentMdWriters.set(agent.name, new Set());
          agentMdWriters.get(agent.name)!.add(runId);
        }
        if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
          // Text from separate messages (with tool calls between) becomes separate paragraphs, not one run-on line.
          if (afterTool && reply && !/\s$/.test(reply)) reply += "\n\n";
          afterTool = false;
          reply += u.content.text;
        }
        if (u.sessionUpdate === "tool_call") afterTool = true;
        if (u.sessionUpdate === "usage_update") {
          const uu = u as any;
          if (typeof uu.used === "number" && typeof uu.size === "number") context = { used: uu.used, size: uu.size };
          if (uu.cost && typeof uu.cost.amount === "number" && (uu.cost.currency ?? "USD") === "USD") {
            if (firstCost == null) firstCost = uu.cost.amount;
            sessionCost = uu.cost.amount;
          }
          const rl = uu._meta?.["_claude/rateLimit"];
          if (rl && typeof rl.status === "string") {
            void writeLimit({ backend: eff.backend, status: rl.status, rateLimitType: rl.rateLimitType, utilization: rl.utilization, resetsAt: rl.resetsAt, updatedAt: new Date().toISOString() });
            if (rl.status === "rejected") limitRejected = { resetsAt: rl.resetsAt ? new Date(rl.resetsAt * 1000) : null };
          }
        }
        void record("update", u);
        o.onUpdate?.(u);
      },
      // Every request is allowed: Overtime's own command check (judge, in permissions.ts) is off for now.
      // What the person protects stays read-only, enforced by the operating system (runtime/sandbox.ts).
      onPermission: (req) => {
        const d = { allowed: true, reason: "allowed" };
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
    await record("start", { kind: o.kind, backend: eff.backend, model: eff.model, sessionId: session.sessionId, fresh, reason: o.reason, instructionsVersion: INSTRUCTIONS_VERSION });
    // Every byte Overtime sends is kept, so you can always see exactly what an agent was told.
    await record("prompt", { text: prompt });

    let res: PromptResult;
    try {
      promptSent = true;
      res = await session.prompt(prompt);
    } catch (e) {
      const lim = limitRejected as { resetsAt: Date | null } | null;
      if (lim) throw new UsageLimitError(eff.backend, lim.resetsAt);
      if (stopped) throw new TurnIncompleteError(stopped, promptSent);
      // A usage limit, whichever backend says so: noted for the backend, so every agent on it waits
      // (see blockedUntil), and reported as a limit rather than a failure.
      if (classify(e) === "limit") {
        await writeLimit({ backend: eff.backend, status: "rejected", updatedAt: new Date().toISOString() });
        throw new UsageLimitError(eff.backend, null);
      }
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
      firstCostUsd: firstCost,
      context,
    });
    recorded = true;
    if (limitRejected) throw new UsageLimitError(eff.backend, (limitRejected as { resetsAt: Date | null }).resetsAt);
    // It got through: a limit recorded for this backend is over, for every agent on it.
    await clearLimit(eff.backend);
    if (o.kind === "main") await updateState(agent.name, { mainSessionId: session.sessionId, mainSessionBackend: eff.backend, mainSessionModel: eff.model ?? null, lastRunAt: new Date().toISOString() });
    if (stopped || res.stopReason === "cancelled") throw new TurnIncompleteError(stopped ?? "the backend cancelled the turn", true);
    return { runId, sessionId: session.sessionId, fresh, reply: reply.trim(), stopReason: res.stopReason, usage: res.usage ?? null, backend: eff.backend, usage2, context, modelIssue };
  } catch (e: any) {
    await record("error", { message: String(e?.message ?? e) });
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
    // A sign-in the backend refreshed during the session goes back to the person's own.
    await isolationEnv(eff.backend, paths.meta(agent.name)).catch(() => {});
    act.count--;
    if (act.count === 0) {
      activeSessions.delete(agent.name);
      // Kept running (the agent decides), but recorded so it and the person can see and control them.
      const fresh = await recordLeftovers(agent.name, act.since, [...act.roots]).catch(() => []);
      if (fresh.length) o.log?.(`[${agent.name}] keeps running in the background: ${fresh.map((b) => `${b.pid} ${b.command.slice(0, 80)}`).join("; ")}`);
    }
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
