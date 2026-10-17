import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeHome, until } from "./helpers.js";

fakeHome();
const { Runtime } = await import("../src/daemon/runtime.js");
const { loadAgent, updateState } = await import("../src/agent/agent.js");
const { paths } = await import("../src/paths.js");

describe("reflect pass vs a person editing AGENT.md", () => {
  const rt = new Runtime(() => {});
  it("keeps the person's AGENT.md edit made while a reflect pass runs", async () => {
    await (rt as any).tools.start();
    await rt.create("race");
    await rt.send("race", "Your job is testing. REFLECT_HOLD");
    await until(async () => (await loadAgent("race")).state.status === "asleep" && !(rt as any).mainRunning.has("race"), 30_000, "turn");
    await updateState("race", { turnsSinceReflect: 8 });
    const ctl = new AbortController();
    const p = (rt as any).reflect("race", "test", ctl);
    const runs = join(paths.meta("race"), "runs");
    await until(async () => readdirSync(runs).some((f) => f.startsWith("reflect_")), 20_000, "reflect started");
    await new Promise((r) => setTimeout(r, 1500));
    const f = join(paths.agent("race"), "AGENT.md");
    const edited = readFileSync(f, "utf8") + "\n- Person's new rule, typed by hand while the agent slept.\n";
    writeFileSync(f, edited);
    ctl.abort(); // the person's message arrives: wakeMain aborts the pass
    await p;
    expect(readFileSync(f, "utf8")).toBe(edited);
  }, 90_000);
});
