import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { fakeHome, here, until } from "./helpers.js";

const home = fakeHome();
const { Runtime, turnAbout } = await import("../src/daemon/runtime.js");
const { ControlServer } = await import("../src/daemon/control.js");
const { loadAgent, updateState } = await import("../src/agent/agent.js");

const rt = new Runtime(() => {});
let control: InstanceType<typeof ControlServer>;
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

describe("an agent's own status line", () => {
  it("is carried over from state saved before it had a place of its own", async () => {
    await rt.create("older");
    await rt.stopAgent("older"); // so the daemon's clock leaves it alone
    const file = join(home, "agents", "older", ".overtime", "state.json");
    const state = (activity: string, activityByAgent: boolean) => writeFileSync(file, JSON.stringify({ formatVersion: 1, status: "stopped", activity, activityByAgent, nextWake: null, mainSessionId: null, mainSessionBackend: null, createdAt: new Date().toISOString(), lastRunAt: null, lastError: null }));
    state("waiting for the API key", true);
    let a = await loadAgent("older");
    expect(a.state.ownStatus).toBe("waiting for the API key");
    expect("activityByAgent" in a.state).toBe(false);
    expect((await control.summary("older")).ownStatus).toBe("waiting for the API key");
    // One of Overtime's lines was never the agent's.
    state("paused: daily budget used", false);
    a = await loadAgent("older");
    expect(a.state.ownStatus).toBe("");
    // Saved on the next change, it stays carried over.
    state("waiting for the API key", true);
    await updateState("older", { lastError: null });
    expect(JSON.parse(readFileSync(file, "utf8")).ownStatus).toBe("waiting for the API key");
  });
});

describe("what a turn is about, for an agent working without a status line of its own", () => {
  let about: ReturnType<typeof rt.store>;
  beforeAll(async () => {
    await rt.create("about");
    about = rt.store("about");
  });
  const store = () => about;
  const item = (o: any) => ({ id: "in_" + Math.random(), t: new Date().toISOString(), text: "", ...o });

  it("is the first words of the person's message, from the message itself rather than the inbox text", async () => {
    const s = store();
    const m = await s.addMessage({ from: "you", kind: "message", text: "  please fix the\nflaky   CI job on main, it keeps timing out in the tui tests since yesterday", baseDir: join(home, "agents", "about") });
    const about = await turnAbout(s, [item({ type: "message", text: m.text + "\n\n(The person started this with /x ...)", messageId: m.id })]);
    expect(about).toBe("on: please fix the flaky CI job on main, it keeps timing out in…");
    expect(about.length).toBeLessThanOrEqual(65);
    // A short one is kept whole; another agent's message, a helper's or a loop don't come before the person.
    const short = await s.addMessage({ from: "you", kind: "message", text: "ship it", baseDir: join(home, "agents", "about") });
    expect(await turnAbout(s, [item({ type: "agent", data: { from: "docs" } }), item({ type: "message", messageId: short.id, text: "ship it" }), item({ type: "loop", text: "hourly CI check" })])).toBe("on: ship it");
  });

  it("names the agent a message came from, a monitor's or repeating wake's reason, and a wake it chose", async () => {
    const s = store();
    expect(await turnAbout(s, [item({ type: "agent", text: "can you review?", data: { from: "docs-writer" } })])).toBe("on: message from docs-writer");
    const mon = await s.addMonitor({ run: "true", everyMs: 60_000, why: "new PR on the deps repo", cooldownMs: 0 });
    expect(await turnAbout(s, [item({ type: "monitor", text: "Monitor fired.\nOutput:\nlots", data: { monitorId: mon.id } })])).toBe("new PR on the deps repo");
    expect(await turnAbout(s, [item({ type: "loop", text: "hourly CI check", data: { loopId: "l1" } })])).toBe("hourly CI check");
    await s.setWake(new Date(Date.now() - 1000), "check the deploy finished", true);
    expect(await turnAbout(s, [])).toBe("check the deploy finished");
    // One Overtime set (a default, a retry) isn't worded for the person: it's a check-in.
    await s.setWake(new Date(Date.now() - 1000), "default wake-up: you didn't choose one last turn (use wake)");
    expect(await turnAbout(s, [])).toBe("routine check-in");
    // Nothing to go on.
    await s.setWake(new Date(Date.now() + 3_600_000), "later", true);
    expect(await turnAbout(s, [item({ type: "helper", text: "helper_x finished", data: { helperId: "helper_x" } })])).toBe("working");
  });

  it("shows in the agent's summary while it works, stays all turn, and is gone when the turn ends", async () => {
    await rt.create("busy");
    await rt.send("busy", "Your job is testing.");
    await until(async () => (await loadAgent("busy")).state.status === "asleep", 30_000, "settled");
    // The fake backend set a status line of its own last turn; this time it hasn't (yet).
    await updateState("busy", { ownStatus: "" });
    await rt.send("busy", "SLOW fix the harbour lights");
    await until(async () => (await loadAgent("busy")).state.status === "working", 30_000, "working");
    const s = await control.summary("busy");
    expect(s.ownStatus).toBe("");
    expect(s.turnAbout).toBe("on: SLOW fix the harbour lights");
    await new Promise((r) => setTimeout(r, 1500));
    expect((await control.summary("busy")).turnAbout).toBe("on: SLOW fix the harbour lights");
    await rt.stopAgent("busy");
    const after = await control.summary("busy");
    expect(after.turnAbout).toBe("");
    expect(after.ownStatus).toBe("");
  });
});

describe("overtime ls", () => {
  const ls = (): Promise<string> =>
    new Promise((resolve) => execFile(join(here, "..", "node_modules", ".bin", "tsx"), [join(here, "..", "src", "cli.ts"), "ls"], { env: { ...process.env, NO_COLOR: "1" }, timeout: 60_000 }, (_e, out, err) => resolve(out + err)));
  const row = (out: string, name: string) => out.split("\n").find((l) => l.includes(name)) ?? "";

  it("shows an agent's own status line, else what its turn is about while it works, never a stopped one's", async () => {
    for (const n of ["ls-own", "ls-turn", "ls-stopped"]) await rt.create(n);
    // Written straight in: no turn runs, so nothing else changes them.
    await updateState("ls-own", { status: "working", activity: "on: fix the build", ownStatus: "bisecting the flaky test" });
    await updateState("ls-turn", { status: "working", activity: "on: fix the build", ownStatus: "" });
    await updateState("ls-stopped", { status: "stopped", activity: "stopped", ownStatus: "bisecting the flaky test" });
    const out = await ls();
    expect(row(out, "ls-own")).toContain("bisecting the flaky test");
    expect(row(out, "ls-own")).not.toContain("on: fix the build");
    expect(row(out, "ls-turn")).toContain("on: fix the build");
    expect(row(out, "ls-stopped")).not.toContain("bisecting");
    expect(row(out, "ls-stopped")).toContain("—");
  });
});
