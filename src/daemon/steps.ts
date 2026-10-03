import { basename } from "node:path";

/** What Overtime's own tools look like to the person: what the agent is doing, not the tool's name. */
const OVERTIME_TOOLS: Record<string, string> = {
  send: "Writing to you",
  ask: "Asking you something",
  wake: "Planning when to work next",
  cancel: "Stopping a watch or helper",
  spawn: "Starting a helper",
  done: "Handing back its result",
  skill: "Reading a skill",
};

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** The file a tool call is about, by name. */
function fileOf(u: any): string {
  const p = u?.locations?.[0]?.path ?? u?.rawInput?.file_path ?? u?.rawInput?.path ?? u?.rawInput?.notebook_path;
  return typeof p === "string" && p ? basename(p) : "";
}

/**
 * A tool call as a few plain words for the person ("Running npm test", "Editing calc.py",
 * "Writing to you"), never a tool's internal name ("Terminal", "mcp__overtime__send"). Null when the
 * call says nothing worth showing.
 */
export function describeStep(u: any): string | null {
  const title: string = typeof u?.title === "string" ? u.title : "";
  const kind: string = typeof u?.kind === "string" ? u.kind : "";
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(title);
  if (mcp) {
    if (mcp[1] === "overtime") return OVERTIME_TOOLS[mcp[2]] ?? `Using Overtime: ${mcp[2]}`;
    return `Using ${mcp[1]}: ${mcp[2].replace(/[_-]+/g, " ")}`;
  }
  const cmd = typeof u?.rawInput?.command === "string" ? u.rawInput.command : Array.isArray(u?.rawInput?.command) ? u.rawInput.command.join(" ") : "";
  if (kind === "execute" || cmd || /^terminal$/i.test(title)) return cmd ? `Running ${short(firstLine(cmd), 60)}` : "Running a command";
  const file = fileOf(u);
  if (/^preparing file/i.test(title) || (kind === "edit" && /^(write|create)/i.test(title))) return file ? `Writing ${file}` : "Writing a file";
  switch (kind) {
    case "read":
      return file ? `Reading ${file}` : "Reading files";
    case "edit":
      return file ? `Editing ${file}` : "Editing a file";
    case "delete":
      return file ? `Deleting ${file}` : "Deleting files";
    case "move":
      return file ? `Moving ${file}` : "Moving files";
    case "search": {
      const q = u?.rawInput?.pattern ?? u?.rawInput?.query;
      return typeof q === "string" && q ? `Searching for ${short(q, 40)}` : "Searching";
    }
    case "fetch": {
      const url = u?.rawInput?.url;
      try {
        return url ? `Looking up ${new URL(url).host}` : `Looking up ${short(firstLine(u?.rawInput?.query ?? title), 40) || "something"}`;
      } catch {
        return "Looking something up";
      }
    }
    case "think":
      return "Thinking";
    case "switch_mode":
      return null;
  }
  // Anything else: its title, unless it's just a tool's name.
  if (!title || /^[A-Za-z]+$/.test(title)) return null;
  return short(title, 80);
}
