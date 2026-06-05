# Client Compatibility

Warden includes a local smoke check for installed Codex and Claude Code clients:

```bash
pnpm run compat:clients
```

The smoke check:

1. Builds Warden.
2. Creates a temporary Warden policy that points at the in-repo fake MCP upstream.
3. Verifies `warden inspect` discovers the fake upstream tools.
4. Registers Warden with Codex using an isolated `CODEX_HOME`.
5. Confirms `codex mcp list --json` lists Warden as a stdio MCP server.
6. Registers Warden with Claude Code in a temporary project.
7. Confirms `claude mcp list` lists Warden.

This does not mutate the user's real Codex or Claude Code MCP config.

## Verified Locally

The current smoke check has passed with:

- Codex CLI `0.137.0`
- Claude Code `2.1.165`

## Current Limit

The smoke check validates client-side MCP registration and config discovery. It does not yet run a model-driven agent session that calls Warden tools through Codex or Claude Code.

Claude Code project MCP servers appear as pending until approved interactively by the user. That is expected for project-scoped `.mcp.json` servers.

## Next Step

Run an interactive client session against Warden and verify:

- the client sees Warden namespaced tools
- an allowed read call executes through Warden
- a denied call returns a structured block
- an approval-required call pauses on the `/dev/tty` reviewer and executes only after approval
