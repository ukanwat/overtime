import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeHome, until } from "./helpers.js";

const home = fakeHome();
const { Runtime } = await import("../src/daemon/runtime.js");
const { loadAgent, updateState } = await import("../src/agent/agent.js");
const { classify, needsPerson, BackendError, BackendExitedError } = await import("../src/runtime/errors.js");

const logs: string[] = [];
let rt = new Runtime((l) => logs.push(l));
afterAll(() => { if (process.env.SHOWLOG) console.log(logs.join("\n")); });
afterAll(async () => rt.stop());
await rt.start();

const dir = (a: string) => join(home, "agents", a);
const alerts = async (a: string) => (await rt.store(a).messages()).filter((m) => m.kind === "alert");
/** The agent's turn with this in its inbox finished (items are delivered only when a turn does). */
const handled = async (a: string, text: string) => {
  const f = join(dir(a), ".overtime", "inbox-delivered.jsonl");
  return existsSync(f) && readFileSync(f, "utf8").includes(text);
};

/** Create an agent and give it its job, so it's an ordinary agent at rest. */
async function employ(name: string) {
  await rt.create(name);
  await rt.send(name, "Your job is testing.");
  await until(async () => (await loadAgent(name)).state.status === "asleep", 30_000, `${name} settled`);
}

describe("telling a backend that isn't signed in from anything else that says 'unauthorized'", () => {
  it("only the backend's own sign-in code means it isn't signed in, never words in a message", () => {
    // ACP's auth-required code, whatever the words.
    expect(classify(new BackendError("claude: Authentication required", "claude", -32000))).toBe("signin");
    // A tool, an MCP server or a website said it (401, "Unauthorized", "please log in"), passed on in a failed turn.
    expect(classify(new BackendError("claude: Internal error: MCP server runpod: HTTP 401 Unauthorized", "claude", -32603, { message: "HTTP 401 Unauthorized" }))).toBe(null);
    expect(classify(new BackendError("claude: Internal error: Authentication required to list pods; please log in", "claude", -32603))).toBe(null);
    // A backend that stopped, whatever its last lines of output said.
    expect(classify(new BackendExitedError("The claude backend stopped (exit 1): fetch https://api.example.com failed: 401 Unauthorized | Not logged in", "claude"))).toBe(null);
    // Overtime's own errors, and an error message read back from an agent's state.
    expect(classify(new Error("claude: Authentication required"))).toBe(null);
    expect(needsPerson(new BackendError("x: unauthorized", "claude", -32603), "claude", "a")).toBe(null);
  });

  it("a turn that fails on a tool's '401 Unauthorized' is an ordinary failure, not 'isn't signed in'", async () => {
    await employ("toolauth");
    await rt.send("toolauth", "TOOL_UNAUTHORIZED");
    await until(async () => (await loadAgent("toolauth")).state.lastError, 30_000, "turn failed");
    const a = await loadAgent("toolauth");
    expect(a.state.lastError).toMatch(/Unauthorized/);
    expect(a.state.signedOut ?? null).toBe(null);
    expect(a.state.failures).toBe(1);
    expect((await alerts("toolauth")).some((m) => /signed in/.test(m.text))).toBe(false);
  });
});

describe("a backend that isn't signed in", () => {
  it("a sign-in that fails for a moment (a locked keychain just after login) passes quietly: no alert, same session", async () => {
    await employ("blip");
    const session = (await loadAgent("blip")).state.mainSessionId;
    writeFileSync(join(dir("blip"), "signed-out"), "");
    await rt.send("blip", "hello BLIP_ONE");
    await until(async () => (await loadAgent("blip")).state.signedOut, 30_000, "sign-in failure noted");
    rmSync(join(dir("blip"), "signed-out"));
    await until(() => handled("blip", "BLIP_ONE"), 60_000, "carried on by itself");
    const a = await loadAgent("blip");
    expect(a.state.signedOut ?? null).toBe(null);
    expect(a.state.lastError).toBe(null);
    expect(a.state.failures ?? 0).toBe(0);
    expect(a.state.mainSessionId).toBe(session);
    expect(await alerts("blip")).toEqual([]);
  });

  it("one that lasts: says what to do once, keeps checking, and carries on by itself in the same session once signed in", async () => {
    await employ("signedout");
    const session = (await loadAgent("signedout")).state.mainSessionId;
    writeFileSync(join(dir("signedout"), "signed-out"), "");
    await rt.send("signedout", "hello LASTING");
    const alert = await until(async () => (await alerts("signedout"))[0], 60_000, "alert");
    expect(alert.text).toMatch(/isn't signed in/);
    expect(alert.text).toMatch(/carries on by itself/);
    const a = await loadAgent("signedout");
    expect(a.state.failures ?? 0).toBe(0); // not the agent failing: its session isn't given up on
    expect(a.state.signedOut?.backend).toBe("fake");
    // It keeps checking, every few minutes at most.
    const wake = (await rt.store("signedout").schedule()).wakeAt;
    expect(wake && new Date(wake).getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    // A few more tries go by without another alert.
    const tries = a.state.signedOut!.tries;
    await until(async () => ((await loadAgent("signedout")).state.signedOut?.tries ?? 0) >= tries + 2, 60_000, "more tries");
    expect(await alerts("signedout")).toHaveLength(1);
    // Signed in: it carries on by itself, nobody wakes it.
    rmSync(join(dir("signedout"), "signed-out"));
    await until(() => handled("signedout", "LASTING"), 60_000, "carried on by itself");
    const b = await loadAgent("signedout");
    expect(b.state.signedOut ?? null).toBe(null);
    expect(b.state.lastError).toBe(null);
    expect(b.state.mainSessionId).toBe(session);
  });

  it("is tried again at once when another turn on the same backend gets through, not at its next check", async () => {
    await employ("waiter");
    await employ("worker");
    await updateState("waiter", { signedOut: { backend: "fake", since: new Date().toISOString(), tries: 5 }, lastError: "fake: Authentication required" });
    await rt.store("waiter").setWake(new Date(Date.now() + 3600_000), "retry after an error: fake: Authentication required");
    // Not from the person (that's always tried at once): something that waits out the back-off.
    await rt.store("waiter").pushInbox({ type: "monitor", text: "WAITER fired" });
    await rt.send("worker", "hello");
    await until(async () => (await loadAgent("waiter")).state.signedOut == null && (await rt.store("waiter").inbox()).length === 0, 60_000, "waiter woke");
  });

  it("is tried again at once by a fresh daemon (opening the app restarts one stuck on sign-in)", async () => {
    await employ("restarted");
    await updateState("restarted", { signedOut: { backend: "fake", since: new Date().toISOString(), tries: 5 }, lastError: "fake: Authentication required" });
    await rt.store("restarted").setWake(new Date(Date.now() + 3600_000), "retry after an error: fake: Authentication required");
    // Not from the person (that's always tried at once): something that waits out the back-off.
    await rt.store("restarted").pushInbox({ type: "monitor", text: "RESTARTED fired" });
    await rt.stop();
    rt = new Runtime((l) => logs.push(l));
    await rt.start();
    await until(async () => (await loadAgent("restarted")).state.signedOut == null && (await rt.store("restarted").inbox()).length === 0, 60_000, "retried at once");
  });

  it("a helper waits for sign-in and carries on, instead of failing", async () => {
    await employ("helpee");
    const mark = join(home, "helper-signed-out");
    writeFileSync(mark, "");
    await rt.send("helpee", "PASS SPAWN_SIGNIN");
    const h = await until(async () => (await rt.store("helpee").helpers())[0], 30_000, "helper started");
    await until(async () => (await rt.trouble("helpee"))?.signIn, 30_000, "waiting on sign-in");
    expect((await rt.store("helpee").helpers())[0].status).toBe("running");
    rmSync(mark);
    const done = await until(async () => (await rt.store("helpee").helpers()).find((x) => x.id === h.id && x.status !== "running"), 60_000, "helper over");
    expect(done.status, done.result).toBe("done");
    expect(existsSync(join(done.workdir, "result.txt"))).toBe(true);
  });
});
