import type { Store } from "../store/store.js";
import type { SessionKind } from "../runtime/turn.js";

/** Who is calling a tool: one entry per live session. */
export interface ToolContext {
  token: string;
  agent: string;
  kind: SessionKind;
  /** For helpers: their id and how deep in the helper tree they are (main = 0). */
  helperId?: string;
  depth: number;
  /** Set when the agent chose its next wake during this turn. */
  wakeChosen: boolean;
  /** Set when this session sent the person a message. */
  sent?: boolean;
  /** For helpers: set when the helper called done. */
  result?: string;
}

/** What tools need from the daemon. Kept as an interface so tools stay testable without a daemon. */
export interface ToolHost {
  store(agent: string): Store;
  agentDir(agent: string): string;
  /** Wake the agent's main session soon (coalesced if one is running). */
  wakeMain(agent: string, reason: string): void;
  spawnHelper(ctx: ToolContext, req: { role?: string; instructions?: string; task: string; backend?: string; model?: string; withContext?: boolean }): Promise<{ id: string; workdir: string; note?: string }>;
  /** Withdraw one of the agent's own open questions. False if there is no such open question. */
  withdrawQuestion(agent: string, questionId: string): Promise<boolean>;
  /** Stop a running helper. False if there is no such running helper. */
  cancelHelper(agent: string, helperId: string): Promise<boolean>;
  /** Send a helper a note: a running one reads it and carries on; a finished one carries on from where it was. */
  tellHelper(agent: string, helperId: string, text: string): Promise<string>;
  /** A helper reports how it's going (urgent: wake the agent for it now). */
  helperUpdate(ctx: ToolContext, text: string, urgent: boolean): Promise<void>;
  /** The agent's helpers, as a few plain lines each: running ones first, then recent ones. */
  helpersReport(agent: string): Promise<string>;
  startMonitor(agent: string, monitorId: string): void;
  stopMonitor(agent: string, monitorId: string): void;
  notify(title: string, body: string): void;
  /** Something visible changed; the terminal app refreshes. */
  changed(agent: string, what: "messages" | "state" | "schedule" | "monitors" | "helpers"): void;
  setActivity(agent: string, text: string): Promise<void>;
  /** One of Overtime's tools started running in this session: what the agent is doing, for the app. */
  toolStarted?(ctx: ToolContext, tool: string): void;
}
