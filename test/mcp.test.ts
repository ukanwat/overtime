import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeHome, until } from "./helpers.js";

const home = fakeHome({
  mcpServers: [
    { name: "shared-a", command: "node", args: ["-e", "0"] },
    { name: "shared-b", url: "http://127.0.0.1:9/mcp" },
  ],
});
const { Runtime } = await import("../src/daemon/runtime.js");
const { loadAgent } = await import("../src/agent/agent.js");
const rt = new Runtime(() => {});

beforeAll(async () => rt.start());
afterAll(async () => rt.stop());

describe("MCP servers", () => {
  it("gives agents the shared servers, their own extras, minus ones they switched off, plus Overtime's tools", async () => {
    await rt.create("mcpbot");
    const md = join(home, "agents", "mcpbot", "AGENT.md");
    writeFileSync(md, `---\nmcpServers:\n  - name: own-c\n    command: node\n    args: ["-e", "0"]\ndisableMcp:\n  - shared-b\n---\n\n` + readFileSync(md, "utf8"));
    await rt.send("mcpbot", "go");
    await until(async () => (await loadAgent("mcpbot")).state.status === "asleep", 30_000, "turn");
    const seen = readFileSync(join(home, "agents", "mcpbot", ".mcp-seen"), "utf8").trim().split(",");
    expect(seen).toContain("shared-a");
    expect(seen).toContain("own-c");
    expect(seen).toContain("overtime");
    expect(seen).not.toContain("shared-b");
    // Its own rewrite of AGENT.md must not lose the person's MCP settings.
    expect((await loadAgent("mcpbot")).settings.disableMcp).toEqual(["shared-b"]);
  });
});
