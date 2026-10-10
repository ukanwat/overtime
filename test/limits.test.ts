import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";
import { rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fakeHome, until } from "./helpers.js";

const home = fakeHome();
const { Runtime } = await import("../src/daemon/runtime.js");
const { loadAgent } = await import("../src/agent/agent.js");
const { blockedUntil } = await import("../src/runtime/usage.js");

const rt = new Runtime(() => {});
beforeAll(async () => rt.start());
afterAll(async () => rt.stop());
beforeEach(() => {
  rmSync(join(home, "limits.json"), { force: true });
  rmSync(join(home, "limit-on"), { force: true });
});

async function employ(name: string) {
  await rt.create(name);
  await rt.send(name, "Your job is testing.");
  await until(async () => (await loadAgent(name)).state.status === "asleep", 30_000, `${name} settled`);
}

describe("a usage limit, on any backend", () => {
  for (const [how, trigger] of [["reported in structure (Codex's way)", "LIMIT_CODEX"], ["reported only in words", "LIMIT_WORDS"]]) {
    it(`pauses the agent instead of failing, when ${how}`, async () => {
      const name = trigger.toLowerCase().replace("_", "-");
      await employ(name);
      await rt.send(name, `${trigger} now`);
      const a = await until(async () => {
        const x = await loadAgent(name);
        return x.state.status === "paused" ? x : null;
      }, 30_000, "paused");
      expect(a.state.pauseReason).toBe("limit");
      expect(a.state.failures ?? 0).toBe(0);
      expect(a.state.lastError ?? null).toBeNull();
      // Noted for the backend, so other agents on it wait too instead of hitting the limit.
      expect(await blockedUntil("fake")).toBeInstanceOf(Date);
      // Your message is kept for when it resumes.
      expect((await rt.store(name).inbox()).some((i) => i.text.includes(trigger))).toBe(true);
      expect((await rt.store(name).messages()).some((m) => m.kind === "alert")).toBe(false);
      // Its kept message hits the limit again whenever it resumes, which would put the limit back in the tests below.
      await rt.stopAgent(name);
    });
  }
});

describe("a usage limit that lifts before its reset (you upgraded, bought more, or the reset time was off)", () => {
  const limitOn = () => writeFileSync(join(home, "limit-on"), "1");
  const limitOff = () => rmSync(join(home, "limit-on"), { force: true });
  const paused = (name: string) => until(async () => ((await loadAgent(name)).state.status === "paused" ? true : null), 30_000, `${name} paused`);

  it("your message makes it try again at once, and it carries on", async () => {
    await employ("lifted");
    limitOn();
    rt.wakeMain("lifted", "test");
    await paused("lifted");
    limitOff(); // lifted early
    await rt.send("lifted", "are you back?");
    await until(async () => (await rt.store("lifted").messages()).some((m) => m.from === "agent" && m.text.includes("are you back?")), 30_000, "answered");
    // The reply is sent during the turn; the limit is cleared once the turn is over.
    await until(async () => ((await loadAgent("lifted")).state.status === "asleep" ? true : null), 30_000, "turn over");
    expect(JSON.parse(readFileSync(join(home, "limits.json"), "utf8")).fake.status).toBe("allowed"); // cleared for every agent
  });

  it("still over: it says so, keeps your message, and stays paused", async () => {
    await employ("stillover");
    limitOn();
    rt.wakeMain("stillover", "test");
    await paused("stillover");
    await rt.send("stillover", "anything?");
    const note = await until(async () => (await rt.store("stillover").messages()).find((m) => m.from === "overtime" && m.text.includes("still at its usage limit")), 30_000, "told");
    expect(note.text).toMatch(/tries again by itself every 15 minutes/);
    expect((await loadAgent("stillover")).state.status).toBe("paused");
    expect((await rt.store("stillover").inbox()).some((i) => i.text.includes("anything?"))).toBe(true);
  });

  it("wake makes it try again too", async () => {
    await employ("woken");
    limitOn();
    rt.wakeMain("woken", "test");
    await paused("woken");
    limitOff();
    await rt.wakeNow("woken");
    await until(async () => ((await loadAgent("woken")).state.status === "asleep" ? true : null), 30_000, "ran");
  });

  it("once one agent gets through, the others on that backend carry on too", async () => {
    await employ("first");
    await employ("second");
    limitOn();
    rt.wakeMain("first", "test");
    rt.wakeMain("second", "test");
    await paused("first");
    await paused("second");
    limitOff();
    await rt.send("first", "go");
    await until(async () => ((await loadAgent("second")).state.status !== "paused" ? true : null), 30_000, "second resumed");
  });
});
