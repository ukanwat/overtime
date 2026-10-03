import { homedir } from "node:os";
import { join } from "node:path";

/** Root of everything Overtime keeps on disk. Override with OVERTIME_HOME. */
export function home(): string {
  return process.env.OVERTIME_HOME ?? join(homedir(), "overtime");
}

export const paths = {
  settings: () => join(home(), "settings.json"),
  secrets: () => join(home(), "secrets.env"),
  agentsDir: () => join(home(), "agents"),
  archiveDir: () => join(home(), "archive"),
  socket: () => join(home(), "overtimed.sock"),
  daemonLog: () => join(home(), "overtimed.log"),
  daemonLock: () => join(home(), "overtimed.lock"),
  agent: (name: string) => join(home(), "agents", name),
  /** Overtime's own bookkeeping for one agent. The agent never manages this. */
  meta: (name: string) => join(home(), "agents", name, ".overtime"),
};
