# The open-world game, as an Overtime agent

This folder is a starting `AGENT.md` for running the open-world game as a persistent Overtime agent
instead of the original shell launcher.

1. Prepare the project and the engine as in [`../README.md`](../README.md) (`project/`, then
   `bin/setup-capabilities.sh`), and start the editor with the MCP server enabled. Note the port
   (the launcher uses `MCP_PORT`, default 8123).
2. Create the agent: `overtime new game-builder`.
3. Copy `AGENT.md` from this folder over `~/overtime/agents/game-builder/AGENT.md`, and edit the
   settings at the top: `workspace` (your project folder), the `unreal` MCP URL and the daily budget.
4. Open `overtime` and tell it to start. It reads the full brief, plans, splits work across helpers,
   checks the result in the running game, and wakes itself as it goes.

The original launcher (`bin/run-agent.sh`) still works and is what produced the screenshots in the
example README.
