import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { fakeHome, here } from "./helpers.js";

fakeHome();
const { Runtime } = await import("../src/daemon/runtime.js");
const { loadAgent } = await import("../src/agent/agent.js");
const { paths } = await import("../src/paths.js");
const { ControlServer } = await import("../src/daemon/control.js");

const rt = new Runtime(() => {});
let control: InstanceType<typeof ControlServer>;

/** The overtime command, as the person runs it. */
function cli(args: string[]): Promise<{ code: number; out: string }> {
  const env = { ...process.env };
  delete env.OVERTIME_AGENT;
  return new Promise((resolve) =>
    execFile(join(here, "..", "node_modules", ".bin", "tsx"), [join(here, "..", "src", "cli.ts"), ...args], { env, timeout: 60_000 }, (e, stdout, stderr) => resolve({ code: e ? ((e as any).code ?? 1) : 0, out: stdout + stderr })),
  );
}

beforeAll(async () => {
  await rt.start();
  control = new ControlServer(rt, () => {}, () => {});
  await control.start();
  control.open();
});
afterAll(async () => {
  await control.stop();
  await rt.stop();
});

describe("overtime new with settings", () => {
  it("creates an agent with the settings given, using the same keys as overtime set", async () => {
    const work = realpathSync(mkdtempSync(join(tmpdir(), "overtime-work-")));
    const r = await cli(["new", "dee", "backend=fake", "model=default", "budget=3", `workspace=${work}`, "visibility=private"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Created dee");
    expect((await loadAgent("dee")).settings).toEqual({ backend: "fake", dailyBudgetUsd: 3, workspace: work, visibility: "private" });
  }, 60_000);

  it("creates one with the defaults when no settings are given", async () => {
    expect((await cli(["new", "eve"])).code).toBe(0);
    expect((await loadAgent("eve")).settings).toEqual({});
  }, 60_000);

  it("refuses a backend that isn't installed, or a folder that isn't there, and makes nothing", async () => {
    const missing = await cli(["new", "fay", "backend=missing"]);
    expect(missing.code).not.toBe(0);
    expect(missing.out).toContain("isn't installed");
    const nowhere = await cli(["new", "fay", "workspace=/no/such/folder"]);
    expect(nowhere.code).not.toBe(0);
    expect(nowhere.out).toContain("There's no folder");
    const unknown = await cli(["new", "fay", "colour=red"]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.out).toContain(`There's no setting "colour"`);
    expect(existsSync(paths.agent("fay"))).toBe(false);
  }, 90_000);
});
