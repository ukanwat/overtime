import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHome } from "./helpers.js";

const home = fakeHome();
const { listSkills, readSkill, skillsBlock } = await import("../src/skills.js");

function skill(dir: string, name: string, description: string, body = "Steps.") {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

describe("skills", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "ot-skill-agent-"));

  it("include Overtime's own guide to itself", () => {
    const s = listSkills(agentDir).find((x) => x.name === "overtime");
    expect(s?.source).toBe("built-in");
    const r = readSkill(agentDir, "overtime")!;
    for (const fact of ["mcpServers", "overtime set", "dailyBudgetUsd", "customBackends", "protect", "overtimed.log"]) expect(r.text).toContain(fact);
  });

  it("come from the person (for every agent) and the agent itself, the agent's own winning on a clash", () => {
    skill(join(home, "skills"), "release", "How we cut a release");
    skill(join(agentDir, "skills"), "release", "My own way to release", "Run ./ship.sh");
    writeFileSync(join(agentDir, "skills", "release", "ship.sh"), "echo ship\n");
    skill(join(home, "skills"), "reports", "Weekly report format");
    const all = listSkills(agentDir);
    expect(all.find((x) => x.name === "reports")?.source).toBe("yours");
    const rel = all.find((x) => x.name === "release")!;
    expect(rel.source).toBe("its own");
    expect(rel.description).toBe("My own way to release");
    const r = readSkill(agentDir, "release")!;
    expect(r.text).toContain("./ship.sh");
    expect(r.files.some((f) => f.endsWith("ship.sh"))).toBe(true);
  });

  it("are listed to every session by name and description only", () => {
    const b = skillsBlock(agentDir);
    expect(b).toContain("- overtime:");
    expect(b).toContain("- release (its own): My own way to release");
    expect(b).not.toContain("Run ./ship.sh");
  });

  it("without front matter still get a name and a description", () => {
    mkdirSync(join(agentDir, "skills", "plain"), { recursive: true });
    writeFileSync(join(agentDir, "skills", "plain", "SKILL.md"), "# Deploying the docs site\n\nRun make docs.\n");
    expect(listSkills(agentDir).find((x) => x.name === "plain")?.description).toBe("Deploying the docs site");
  });
});
