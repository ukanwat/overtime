import { describe, it, expect, beforeEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fakeHome } from "./helpers.js";
import { createAgent, updateState } from "../src/agent/agent.js";
import { stuckOnSignIn } from "../src/daemon/client.js";

describe("a daemon stuck on sign-in", () => {
  let home = "";
  beforeEach(() => {
    home = fakeHome();
    delete process.env.OVERTIME_AGENT;
  });

  it("is replaced when an agent keeps failing on sign-in and none is working, at most once in a while", async () => {
    await createAgent("signedout");
    expect(await stuckOnSignIn()).toBe(false);
    await updateState("signedout", { lastError: "claude: Authentication required" });
    expect(await stuckOnSignIn()).toBe(true);
    expect(await stuckOnSignIn()).toBe(false); // just restarted: not again right away
    rmSync(join(home, "signin-restart.json"));
    expect(await stuckOnSignIn()).toBe(true);
  });

  it("is left alone while an agent is working, and never replaced from an agent's own processes", async () => {
    await createAgent("busy");
    await createAgent("signedout");
    await updateState("signedout", { lastError: "claude: Authentication required" });
    await updateState("busy", { status: "working" });
    expect(await stuckOnSignIn()).toBe(false);
    await updateState("busy", { status: "asleep" });
    process.env.OVERTIME_AGENT = "signedout";
    expect(await stuckOnSignIn()).toBe(false);
  });
});
