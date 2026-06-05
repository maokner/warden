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

On June 5, 2026, a model-driven Codex smoke test also passed:

- temporary Warden config pointed at the in-repo fake MCP upstream
- Codex was launched with CLI-only MCP config overrides, `--ephemeral`, and `--ignore-user-config`
- Codex called `warden/fixture.read_echo` through `warden proxy`
- Warden wrote an audit event for `fixture.read_echo`
- Codex returned `called:read_echo`

Claude Code model-driven testing was attempted with `--mcp-config` and `--strict-mcp-config`, but the local Claude install was not logged in and returned `Not logged in`.

## Current Limit

The automated smoke check validates client-side MCP registration and config discovery. It does not run model-driven agent sessions by default because those require authenticated clients and may spend model tokens.

Claude Code project MCP servers appear as pending until approved interactively by the user. That is expected for project-scoped `.mcp.json` servers.

## Next Step

Finish model-driven client testing:

- authenticate Claude Code locally and rerun the allowed read-tool smoke
- verify denied calls return a structured block in Codex and Claude Code
- verify approval-required calls pause on the `/dev/tty` reviewer and execute only after approval
