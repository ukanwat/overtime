import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
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
  /** Unix socket paths are limited to ~104 bytes on macOS; fall back to a short path for long homes. */
  socket: () => {
    const p = join(home(), "overtimed.sock");
    if (Buffer.byteLength(p) < 100) return p;
    return join(tmpdir(), `overtime-${createHash("sha1").update(home()).digest("hex").slice(0, 12)}.sock`);
  },
  daemonLog: () => join(home(), "overtimed.log"),
  daemonLock: () => join(home(), "overtimed.lock"),
  agent: (name: string) => join(home(), "agents", name),
  /** Overtime's own bookkeeping for one agent. The agent never manages this. */
  meta: (name: string) => join(home(), "agents", name, ".overtime"),
};
