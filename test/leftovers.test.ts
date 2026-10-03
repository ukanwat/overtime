import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLeftovers, stopLeftovers } from "../src/runtime/leftovers.js";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Start `sleep` in the background from a shell that then exits, as an agent's `cmd &` would. Returns its pid. */
function orphan(cwd: string): number {
  const out = execFileSync("/bin/sh", ["-c", "sleep 60 >/dev/null 2>&1 & echo $!"], { cwd, encoding: "utf8" });
  return Number(out.trim());
}

describe("processes a session leaves running", () => {
  it("are found when started in the agent's folders during the session, and stopped", async () => {
    const since = Date.now();
    const mine = mkdtempSync(join(tmpdir(), "ot-left-mine-"));
    const other = mkdtempSync(join(tmpdir(), "ot-left-other-"));
    const a = orphan(mine);
    const b = orphan(other);
    await new Promise((r) => setTimeout(r, 300));
    const found = await findLeftovers(since, [mine]);
    expect(found).toContain(a);
    expect(found).not.toContain(b);
    expect(await stopLeftovers(since, [mine])).toBeGreaterThanOrEqual(1);
    expect(alive(a)).toBe(false);
    expect(alive(b)).toBe(true);
    process.kill(b);
    rmSync(mine, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  it("leave alone anything started before the session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ot-left-old-"));
    const old = orphan(dir);
    await new Promise((r) => setTimeout(r, 2100));
    expect(await findLeftovers(Date.now(), [dir])).not.toContain(old);
    process.kill(old);
    rmSync(dir, { recursive: true, force: true });
  });
});
