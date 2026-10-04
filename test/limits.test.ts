import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fakeHome, until } from "./helpers.js";

const home = fakeHome();
const { Runtime } = await import("../src/daemon/runtime.js");
const { loadAgent } = await import("../src/agent/agent.js");
const { blockedUntil } = await import("../src/runtime/usage.js");

const rt = new Runtime(() => {});
beforeAll(async () => rt.start());
afterAll(async () => rt.stop());
beforeEach(() => rmSync(join(home, "limits.json"), { force: true }));

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
    });
  }
});
