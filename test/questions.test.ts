import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { fakeHome, here } from "./helpers.js";

fakeHome();
const { Runtime } = await import("../src/daemon/runtime.js");
const { ControlServer } = await import("../src/daemon/control.js");
const { paths } = await import("../src/paths.js");

// No agent ever runs here: each is stopped, so answers wait in its inbox to be read back.
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

async function agent(name: string) {
  await rt.create(name);
  await rt.stopAgent(name);
}
const ask = (name: string, q: Record<string, unknown>) => rt.store(name).addMessage({ from: "agent", kind: "question", text: "", ...q, baseDir: paths.agent(name) } as any);
const card = (name: string) =>
  ask(name, {
    title: "Before I cut the 2.0 release",
    text: "1. Which platforms?\n2. Which version?\n3. Who to credit?",
    category: "release",
    questions: [
      { text: "Which platforms?", options: ["macOS", "Linux", "Windows"] },
      { text: "Which version?", options: ["2.0.0", "1.9.0"], single: true },
      { text: "Who to credit?" },
    ],
  });
const lastInbox = async (name: string) => (await rt.store(name).inbox()).at(-1)!;

beforeAll(async () => {
  control = new ControlServer(rt, () => {}, () => {});
  await control.start();
  control.open();
  for (const n of ["ann", "bob"]) await agent(n);
});
afterAll(async () => {
  await control.stop();
  await rt.stop();
});

describe("answering questions", () => {
  it("takes several options of one question, and the agent reads them as a list", async () => {
    const q = await ask("ann", { text: "Which platforms?", options: ["macOS", "2 — Linux", "Windows"] });
    await rt.answer("ann", q.id, [3, 2], "arm64 first");
    const a = (await rt.store("ann").message(q.id))!.answer!;
    expect(a.choices).toEqual([2, 3]);
    expect(a.choice).toBe(2);
    expect(a.note).toBe("arm64 first");
    const item = await lastInbox("ann");
    expect(item.text).toBe("2. Linux; 3. Windows — arm64 first");
    expect(item.data).toMatchObject({ question: "Which platforms?", answers: [{ question: "Which platforms?", chosen: ["Linux", "Windows"], note: "arm64 first" }] });
  });

  it("keeps a single pick the way it always was", async () => {
    const q = await ask("ann", { text: "Merge it?", options: ["Merge", "Wait"] });
    await rt.answer("ann", q.id, 1);
    const a = (await rt.store("ann").message(q.id))!.answer!;
    expect(a.choice).toBe(1);
    expect(a.choices).toBeUndefined();
    expect((await lastInbox("ann")).text).toBe("1. Merge");
  });

  it("refuses several picks on a question that takes one, and options that aren't there", async () => {
    const q = await ask("ann", { text: "Which version?", options: ["2.0.0", "1.9.0"], single: true });
    await expect(rt.answer("ann", q.id, [1, 2])).rejects.toThrow("That question takes one option.");
    await expect(rt.answer("ann", q.id, [3])).rejects.toThrow("There is no option 3.");
    expect((await rt.store("ann").message(q.id))!.answer).toBeUndefined();
  });

  it("answers a card of several questions together, leaving out the ones you skip", async () => {
    const q = await card("ann");
    await rt.answer("ann", q.id, undefined, undefined, [{ choices: [1, 3] }, {}, { note: "Ana and Bo" }]);
    const a = (await rt.store("ann").message(q.id))!.answer!;
    expect(a.replies).toEqual([{ choices: [1, 3] }, {}, { note: "Ana and Bo" }]);
    const item = await lastInbox("ann");
    expect(item.text).toBe("Q1. Which platforms?\n→ 1. macOS; 3. Windows\nQ2. Which version?\n→ (left unanswered)\nQ3. Who to credit?\n→ Ana and Bo");
    expect(item.data).toMatchObject({ question: "Before I cut the 2.0 release", answers: [{ chosen: ["macOS", "Windows"] }, { chosen: [] }, { chosen: [], note: "Ana and Bo" }] });
    // One decision per question answered, for earned autonomy.
    const ds = (await rt.store("ann").decisions()).filter((d) => d.threadId === q.id);
    expect(ds.map((d) => d.question)).toEqual(["Which platforms?", "Who to credit?"]);
  });

  it("refuses a card answer with nothing in it, or two picks where a question takes one", async () => {
    const q = await card("ann");
    await expect(rt.answer("ann", q.id, undefined, undefined, [{}, {}, {}])).rejects.toThrow("Pick an option or write an answer.");
    await expect(rt.answer("ann", q.id, undefined, undefined, [{}, { choices: [1, 2] }])).rejects.toThrow("Question 2 takes one option.");
    await rt.dismissQuestion("ann", q.id);
    expect((await lastInbox("ann")).text).toContain("The person dismissed your questions without answering");
  });

  it("withdraws a whole card at once, with its why", async () => {
    const q = await card("ann");
    expect(await rt.withdrawQuestion("ann", q.id, "you said ship it")).toBe(true);
    expect((await rt.store("ann").message(q.id))!.answer).toMatchObject({ closed: "withdrawn", note: "you said ship it" });
  });
});

describe("overtime answer and messages", () => {
  it("answers with several options as 1,3 and a note", async () => {
    const q = await ask("bob", { text: "Which platforms?", options: ["macOS", "Linux", "Windows"] });
    const ms = await cli(["messages", "bob"]);
    expect(ms.out).toContain("Pick any:");
    expect(ms.out).toContain("Answer with: overtime answer bob <1-3> (or several, like 1,3)");
    const r = await cli(["answer", "bob", "1,3", "arm64 first"]);
    expect(r.out).toContain("Answered.");
    expect((await rt.store("bob").message(q.id))!.answer).toMatchObject({ choices: [1, 3], note: "arm64 first" });
    const after = await cli(["messages", "bob"]);
    expect(after.out).toMatch(/✓ {2}macOS/);
    expect(after.out).toMatch(/✓ {2}Windows/);
    expect(after.out).toContain("You: arm64 first");
  }, 60_000);

  it("refuses 1,2 on a question that takes one, and an option past the last", async () => {
    const q = await ask("bob", { text: "Which version?", options: ["2.0.0", "1.9.0"], single: true });
    let r = await cli(["answer", "bob", "1,2"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("bob's question takes one option.");
    r = await cli(["answer", "bob", "1,4"]);
    expect(r.out).toContain("There is no option 4. bob's question has 2.");
    expect((await rt.store("bob").message(q.id))!.answer).toBeUndefined();
    await rt.dismissQuestion("bob", q.id);
  }, 60_000);

  it("answers a card question by question, - leaving one, and shows it answered", async () => {
    const q = await card("bob");
    const ms = await cli(["messages", "bob"]);
    expect(ms.out).toContain("Before I cut the 2.0 release");
    expect(ms.out).toContain("Q2 Which version?");
    expect(ms.out).toContain("Answer with: overtime answer bob <Q1> <Q2> <Q3>");
    const r = await cli(["answer", "bob", "2", "-", "Ana", "and", "Bo"]);
    expect(r.out).toContain("Answered.");
    // The words after the picks are about the whole card.
    expect((await rt.store("bob").message(q.id))!.answer).toMatchObject({ replies: [{ choices: [2] }, {}, {}], note: "Ana and Bo" });
    const after = await cli(["messages", "bob"]);
    expect(after.out).toMatch(/✓ {2}Linux/);
    expect(after.out).toContain("(left unanswered)");
    expect(after.out).toContain("You: Ana and Bo");
  }, 60_000);

  it("shows withdrawn questions with the agent's why, never as an answer of yours", async () => {
    const one = await ask("bob", { text: "Can I deploy on Friday?", options: ["Yes", "No"] });
    await rt.withdrawQuestion("bob", one.id, "you gave me full access");
    const two = await card("bob");
    await rt.withdrawQuestion("bob", two.id);
    const r = await cli(["messages", "bob"]);
    expect(r.out).toContain("✕ bob withdrew this: you gave me full access");
    expect(r.out).toContain("✕ bob withdrew this question (no longer needed)");
    expect(r.out).not.toContain("Withdrawn");
  }, 60_000);
});
