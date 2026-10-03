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
  spawnHelper(ctx: ToolContext, req: { role?: string; instructions?: string; task: string; backend?: string; model?: string }): Promise<{ id: string; workdir: string }>;
  /** Stop a running helper. False if there is no such running helper. */
  cancelHelper(agent: string, helperId: string): Promise<boolean>;
  startMonitor(agent: string, monitorId: string): void;
  stopMonitor(agent: string, monitorId: string): void;
  notify(title: string, body: string): void;
  /** Something visible changed; the terminal app refreshes. */
  changed(agent: string, what: "messages" | "state" | "schedule" | "monitors" | "helpers"): void;
  setActivity(agent: string, text: string): Promise<void>;
}
