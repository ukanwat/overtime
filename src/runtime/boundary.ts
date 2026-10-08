import type { SessionUpdate } from "../acp/session.js";

/**
 * Stops a turn between steps, never during one. A message for a busy session waits until the tool
 * calls in flight have finished, so a running command, render or edit is never cut off.
 */
export class StepBoundary {
  private inFlight = new Set<string>();
  private pending: (() => void) | null = null;

  /** A new attempt at the same turn takes over a stop that was still waiting on the last one. */
  constructor(previous?: StepBoundary) {
    if (previous?.pending) this.stop(previous.pending);
  }

  /** Feed it every update of the turn. */
  update(u: SessionUpdate): void {
    if (u.sessionUpdate !== "tool_call" && u.sessionUpdate !== "tool_call_update") return;
    const tc = u as any;
    if (typeof tc.toolCallId !== "string") return;
    if (tc.status === "completed" || tc.status === "failed") this.inFlight.delete(tc.toolCallId);
    else if (u.sessionUpdate === "tool_call") this.inFlight.add(tc.toolCallId);
    if (!this.inFlight.size) this.fire();
  }

  /** Stop now if no tool is running, otherwise as soon as the running ones finish. */
  stop(abort: () => void): void {
    this.pending = abort;
    if (!this.inFlight.size) this.fire();
  }

  private fire(): void {
    const abort = this.pending;
    this.pending = null;
    abort?.();
  }
}
