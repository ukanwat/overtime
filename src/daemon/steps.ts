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


/**
 * A tool call as a few calm words for the person: what kind of thing the agent is doing ("Running a
 * command", "Editing files", "Writing to you"), never a tool's internal name or the gory details.
 * Null when the call says nothing worth showing.
 */
export function describeStep(u: any): string | null {
  const title: string = typeof u?.title === "string" ? u.title : "";
  const kind: string = typeof u?.kind === "string" ? u.kind : "";
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(title);
  if (mcp) return mcp[1] === "overtime" ? (OVERTIME_TOOLS[mcp[2]] ?? "Working") : `Using ${mcp[1]}`;
  if (kind === "execute" || u?.rawInput?.command || /^terminal$/i.test(title)) return "Running a command";
  if (/^preparing file/i.test(title)) return "Writing files";
  switch (kind) {
    case "read":
      return "Reading files";
    case "edit":
      return "Editing files";
    case "delete":
    case "move":
      return "Tidying files";
    case "search":
      return "Searching";
    case "fetch":
      return "Looking things up";
    case "think":
      return "Thinking";
    default:
      return null;
  }
}
