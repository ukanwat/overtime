import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeHome, until } from "./helpers.js";

// Nothing protected, and no private agents: nothing the person configured calls for a sandbox.
fakeHome({ protect: [] });
const { Runtime } = await import("../src/daemon/runtime.js");
const { loadAgent } = await import("../src/agent/agent.js");
const { paths } = await import("../src/paths.js");

describe("a helper's sandbox", () => {
  const rt = new Runtime(() => {});
  const turns = (a: string) => readdirSync(join(paths.meta(a), "runs")).filter((f) => f.startsWith("main_")).length;

  beforeAll(async () => {
    await rt.start();
  });
  afterAll(async () => {
    await rt.stop();
  });

  it("runs a helper unsandboxed when the person protects nothing: its parent's memory is read-only by instructions only", async () => {
    await rt.create("hs");
    await rt.send("hs", "SPAWN_MEMREAD");
    await until(async () => (await loadAgent("hs")).state.status === "asleep" && existsSync(join(paths.meta("hs"), "runs")) && turns("hs") > 0 && !(rt as any).mainRunning.has("hs"), 30_000, "hs's turn");
    const h = await until(async () => (await rt.store("hs").helpers()).find((x) => x.task.startsWith("READ_PARENT_MEMORY") && x.status !== "running"), 60_000, "helper done");
    expect(h.status).toBe("done");
    const run = readdirSync(join(paths.meta("hs"), "runs")).find((f) => f.startsWith("helper_"))!;
    const log = readFileSync(join(paths.meta("hs"), "runs", run), "utf8");
    // Unsandboxed, so it can run what uses a sandbox of its own (sandbox-exec, bubblewrap, Codex's).
    expect(JSON.parse(log.split("\n").find((l) => l.includes('"event":"start"'))!).data.sandboxed).toBe(false);
    expect(log).toContain("it's read-only for you");
  });
});
