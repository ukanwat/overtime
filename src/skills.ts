import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { home } from "./paths.js";
import { parseFrontMatter } from "./agent/frontmatter.js";

/**
 * Skills: know-how an agent loads when it's relevant. A skill is a folder with a SKILL.md (front matter
 * `name` and a one-line `description`, then Markdown), plus any scripts or references beside it. Every
 * session sees only the list (name and description); the full text is loaded on demand with the skill
 * tool, so a hundred skills cost a hundred lines, not a hundred documents.
 *
 * Three places, the later one winning on a name clash: built into Overtime, the person's for every agent
 * (~/overtime/skills), and the agent's own (skills/ in its folder).
 */
export type SkillSource = "built-in" | "yours" | "its own";

export interface Skill {
  name: string;
  description: string;
  dir: string;
  file: string;
  source: SkillSource;
}

/** Built-in skills ship in the package's skills/ folder (one level above src/ and dist/). */
export function builtinSkillsDir(): string {
  return fileURLToPath(new URL("../skills/", import.meta.url));
}

function scan(dir: string, source: SkillSource): Skill[] {
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const n of names.sort()) {
    const skillDir = join(dir, n);
    const file = join(skillDir, "SKILL.md");
    try {
      if (!statSync(skillDir).isDirectory() || !existsSync(file)) continue;
      const { data, body } = parseFrontMatter(readFileSync(file, "utf8"));
      const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : n;
      // A description is what makes a skill findable; fall back to its first line of text.
      const description =
        typeof data.description === "string" && data.description.trim()
          ? data.description.trim()
          : (body.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "");
      out.push({ name, description: description.replace(/\s+/g, " ").slice(0, 300), dir: skillDir, file, source });
    } catch {}
  }
  return out;
}

/** Every skill this agent has, one per name. */
export function listSkills(agentDir: string): Skill[] {
  const byName = new Map<string, Skill>();
  for (const s of [...scan(builtinSkillsDir(), "built-in"), ...scan(join(home(), "skills"), "yours"), ...scan(join(agentDir, "skills"), "its own")]) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A skill's full text, and the other files in its folder (by path), or null if there's no such skill. */
export function readSkill(agentDir: string, name: string): { skill: Skill; text: string; files: string[] } | null {
  const skill = listSkills(agentDir).find((s) => s.name === name || s.name.toLowerCase() === name.trim().toLowerCase());
  if (!skill) return null;
  const files: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3 || files.length >= 100) return;
    for (const n of readdirSync(d).sort()) {
      if (n.startsWith(".")) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p, depth + 1);
      else if (p !== skill.file) files.push(p);
    }
  };
  try {
    walk(skill.dir, 0);
  } catch {}
  return { skill, text: readFileSync(skill.file, "utf8"), files };
}

/** The list every session starts with: one line per skill. */
export function skillsBlock(agentDir: string): string {
  const skills = listSkills(agentDir);
  if (!skills.length) return "";
  const lines = skills.map((s) => `- ${s.name}${s.source === "built-in" ? "" : ` (${s.source})`}: ${s.description}`);
  return `# Skills\n\nKnow-how to load with the skill tool when it's relevant:\n\n${lines.join("\n")}`;
}
