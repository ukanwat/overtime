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

/** The step for one of Overtime's own tools, reported by Overtime itself when the tool runs. */
export function ownToolStep(tool: string): string {
  return OVERTIME_TOOLS[tool] ?? "Working";
}

/**
 * Which MCP server a tool call goes to, from what the backend says about it: Claude's
 * `_meta.claudeCode.mcpServer`, Codex's `rawInput.server` on an MCP call; otherwise the tool's name,
 * split into its parts and matched against the servers this agent actually has (every backend puts the
 * server's name in the tool's name, each with its own separator).
 */
function mcpServerOf(u: any, servers: readonly string[]): string | null {
  const meta = u?._meta ?? {};
  const named = meta.claudeCode?.mcpServer?.name;
  if (typeof named === "string") return named;
  if (meta.is_mcp_tool_call === true && typeof u?.rawInput?.server === "string") return u.rawInput.server;
  const name = [meta.claudeCode?.toolName, u?.name, u?.title].find((x) => typeof x === "string" && x) as string | undefined;
  if (!name) return null;
  const parts = new Set(name.split(/__|[.:/]/));
  return servers.find((s) => parts.has(s)) ?? null;
}

/**
 * A tool call as a few calm words for the person: what kind of thing the agent is doing ("Running a
 * command", "Editing files"), from the call's ACP kind, never a tool's internal name or the gory details.
 * Null when the call says nothing worth showing, and for Overtime's own tools, whose step Overtime
 * reports itself when they run (see ownToolStep).
 */
export function describeStep(u: any, servers: readonly string[] = []): string | null {
  const server = mcpServerOf(u, ["overtime", ...servers]);
  if (server === "overtime") return null;
  if (server) return `Using ${server}`;
  switch (typeof u?.kind === "string" ? u.kind : "") {
    case "execute":
      return "Running a command";
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
