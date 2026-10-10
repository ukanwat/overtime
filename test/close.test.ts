import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHome, until } from "./helpers.js";

fakeHome();
const { AcpSession } = await import("../src/acp/session.js");

describe("closing a backend", () => {
  it("lets what it runs underneath finish by itself (saving the session, its running cost) before anything is killed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "overtime-close-"));
    const s = await AcpSession.open({ backend: "fake", cwd, mcpServers: [], onPermission: () => ({ outcome: { outcome: "cancelled" } }) as any });
    await s.newSession();
    await s.prompt("SAVE_ON_EXIT");
    await s.close();
    await until(async () => existsSync(join(cwd, "saved.txt")), 3_000, "the underlying CLI saved");
    expect(existsSync(join(cwd, "saved.txt"))).toBe(true);
  });
});
