# MCP Gateway

Warden now includes a minimal stdio MCP gateway.

## Supported MCP Surface

Current support:

- JSON-RPC over newline-delimited stdio
- `initialize`
- `notifications/initialized`
- `ping`
- `tools/list`
- `tools/call`
- one or more stdio upstream MCP servers
- namespaced tool exposure
- Warden policy/audit pipeline on every `tools/call`

Not yet supported:

- streamable HTTP MCP
- resources
- prompts
- tool-list pagination
- cancellation
- progress notifications
- OAuth
- pending-token approval mode for long-running or non-terminal approvals

## Namespacing

Upstream tools are exposed as:

```text
<upstream>.<tool>
```

Example:

```text
github.create_issue
filesystem.write_file
slack.send_message
```

The agent does not choose an upstream through a free-form parameter. Warden owns routing.

## Config Shape

```yaml
defaults:
  read: allow
  write: require_approval
  destructive: require_approval
  external_send: require_approval
  code_execution: require_approval
  file_mutation: require_approval
  network_egress: require_approval
  credential_access: deny
  financial: deny
  sensitive_data: require_approval
  unknown: require_approval

audit:
  path: .warden/audit.jsonl

upstreams:
  filesystem:
    transport: stdio
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-filesystem"
      - "."
    startup_timeout_ms: 10000
    tool_timeout_ms: 60000
```

Run:

```bash
warden proxy --config warden.yaml
```

## Approval Side Channel

The stdio MCP transport uses stdin/stdout for protocol traffic, so Warden cannot prompt for human approval on the same streams.

Current behavior:

- `allow` calls are forwarded.
- `deny` calls are blocked.
- `require_approval` calls pause for a `/dev/tty` terminal prompt when a terminal side channel is available.
- `require_approval` calls fail closed when no approval side channel is available.

Next step:

- test model-driven tool calls through real Codex and Claude Code sessions, then fill MCP compatibility gaps based on concrete failures.
