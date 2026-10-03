import { join } from "node:path";
import { paths } from "../paths.js";
import { appendJsonl, newId } from "../fsutil.js";
import { AcpSession, type SessionUpdate, type PromptResult } from "../acp/session.js";
import { effectiveSettings, loadAgent, updateState, type Agent } from "../agent/agent.js";
import type { McpServerConfig } from "../settings.js";
import { workingInstructions } from "./instructions.js";
import { answer, judge } from "./permissions.js";

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
  const eff = await effectiveSettings(agent);
  const runId = newId(o.kind);
  const runLog = join(paths.meta(agent.name), "runs", `${runId}.jsonl`);
  const record = (event: string, data: unknown) => appendJsonl(runLog, { t: new Date().toISOString(), event, data });

  let reply = "";
  const session = await AcpSession.open({
    backend: eff.backend,
    cwd: eff.workspace,
    mcpServers: [...eff.mcpServers, ...(o.extraMcp ?? [])],
    onUpdate: (u) => {
      if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") reply += u.content.text;
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
    const header = `Time now: ${now.toISOString()} (${now.toString()}).\nWhy you are awake: ${o.reason}`;
    const prompt = fresh ? `${sessionPreamble(agent)}\n\n---\n\n${header}\n\n${o.text}` : `${header}\n\n${o.text}`;
    await record("start", { kind: o.kind, backend: eff.backend, model: eff.model, sessionId: session.sessionId, fresh, reason: o.reason });
    const res = await session.prompt(prompt);
    await record("end", { stopReason: res.stopReason, usage: res.usage ?? null });
    await appendJsonl(join(paths.meta(agent.name), "usage.jsonl"), {
      t: new Date().toISOString(),
      runId,
      kind: o.kind,
      backend: eff.backend,
      usage: res.usage ?? null,
      meta: (res as any)._meta ?? null,
    });
    if (o.kind === "main") {
      await updateState(agent.name, { mainSessionId: session.sessionId, mainSessionBackend: eff.backend, lastRunAt: new Date().toISOString(), lastError: null });
    }
    return { runId, sessionId: session.sessionId, fresh, reply: reply.trim(), stopReason: res.stopReason, usage: res.usage ?? null, backend: eff.backend };
  } catch (e: any) {
    await record("error", { message: String(e?.message ?? e) });
    if (o.kind === "main") await updateState(agent.name, { lastError: String(e?.message ?? e) });
    throw e;
  } finally {
    await session.close();
  }
}
