import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { fakeHome, until } from "./helpers.js";

fakeHome();
const { Runtime } = await import("../src/daemon/runtime.js");
const { loadAgent, updateState } = await import("../src/agent/agent.js");
const { statusParts } = await import("../src/tui/style.js");

const rt = new Runtime(() => {});
let online = true;
rt.probe = async () => online;
beforeAll(async () => rt.start());
afterAll(async () => rt.stop());

describe("when the internet goes out", () => {
  it("says so instead of 'working', and everything waiting carries on once it's back", async () => {
    await rt.create("wanderer");
    await rt.send("wanderer", "Your job is testing.");
    await until(async () => (await loadAgent("wanderer")).state.status === "asleep", 30_000, "settled");

    // Its backend couldn't be reached, and this machine is offline.
    await updateState("wanderer", { troubleSince: new Date().toISOString(), transientFailures: 1 });
    online = false;
    (rt as any).lastProgress = 0;
    await (rt as any).checkNetwork([await loadAgent("wanderer")], true);
    expect(rt.offlineSince).toBeTruthy();
    expect(await rt.trouble("wanderer")).toMatchObject({ backend: "fake" });

    // In the app: waiting, because there's no internet, even while helpers are still running.
    const a = await loadAgent("wanderer");
    const p = statusParts({ status: "asleep", activity: a.state.activity, nextWake: null, pausedUntil: null, lastError: null, helpersRunning: 2, trouble: await rt.trouble("wanderer"), offlineSince: rt.offlineSince });
    expect(p).toMatchObject({ word: "waiting", detail: "no internet" });
    // Online again but the backend still unreachable: says which.
    expect(statusParts({ status: "asleep", activity: "", nextWake: null, pausedUntil: null, lastError: null, trouble: { since: "", backend: "claude" }, offlineSince: null })).toMatchObject({ word: "waiting", detail: "can't reach claude" });

    // Back online: it tries again at once, not at its next back-off time.
    await rt.store("wanderer").setWake(new Date(Date.now() + 3600_000), "retry later");
    online = true;
    await (rt as any).checkNetwork([await loadAgent("wanderer")], true);
    expect(rt.offlineSince).toBeNull();
    const s = await rt.store("wanderer").schedule();
    expect(new Date(s.wakeAt!).getTime()).toBeLessThan(Date.now() + 60_000);
    await until(async () => !(await loadAgent("wanderer")).state.troubleSince, 30_000, "recovered");
  });
});
