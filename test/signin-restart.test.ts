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

  it("is replaced when an agent's backend says it isn't signed in and none is working, at most once in a while", async () => {
    await createAgent("signedout");
    expect(await stuckOnSignIn()).toBe(false);
    // An error that only mentions it (a tool's or a website's "401 Unauthorized") is no reason to restart.
    await updateState("signedout", { lastError: "claude: Internal error: MCP server runpod: 401 Unauthorized. Authentication required" });
    expect(await stuckOnSignIn()).toBe(false);
    await updateState("signedout", { lastError: "claude: Authentication required", signedOut: { backend: "claude", since: new Date().toISOString(), tries: 3 } });
    expect(await stuckOnSignIn()).toBe(true);
    expect(await stuckOnSignIn()).toBe(false); // just restarted: not again right away
    rmSync(join(home, "signin-restart.json"));
    expect(await stuckOnSignIn()).toBe(true);
  });

  it("is left alone while an agent is working, and never replaced from an agent's own processes", async () => {
    await createAgent("busy");
    await createAgent("signedout");
    await updateState("signedout", { lastError: "claude: Authentication required", signedOut: { backend: "claude", since: new Date().toISOString(), tries: 3 } });
    await updateState("busy", { status: "working" });
    expect(await stuckOnSignIn()).toBe(false);
    await updateState("busy", { status: "asleep" });
    process.env.OVERTIME_AGENT = "signedout";
    expect(await stuckOnSignIn()).toBe(false);
  });
});
