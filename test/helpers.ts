import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));

/** A fresh OVERTIME_HOME whose default backend is the scripted fake agent. */
export function fakeHome(extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "overtime-test-"));
  process.env.OVERTIME_HOME = dir;
  process.env.OVERTIME_NO_NOTIFY = "1"; // no real desktop notifications from test agents
  mkdirSync(join(dir, "protected"), { recursive: true });
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      backend: "fake",
      // On macOS (which can always enforce it), one protected path, so end-to-end tests run with protection on.
      protect: process.platform === "darwin" ? [join(dir, "protected")] : [],
      customBackends: { fake: { command: join(here, "..", "node_modules", ".bin", "tsx"), args: [join(here, "fake-agent.ts")] } },
      ...extra,
    }),
  );
  return dir;
}

export async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 30_000, what = "condition"): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
