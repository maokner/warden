# Build Plan

## Product We Are Building

Warden is a trusted action boundary for AI agents.

The product has two linked jobs:

1. Govern tool calls while they happen.
2. Reduce the ways an agent can route around that governance.

The first version should be local-first, CLI-first, and useful for app backends, database-backed chatbots, MCP clients, and coding agents.

## Core Architecture

```text
Agent / Chatbot / MCP Client
  |
  v
App SDK Guard / Warden MCP Gateway / Future HTTP Sidecar
  |
  +-- Tool Registry
  +-- Risk Classifier
  +-- Policy Engine
  +-- Approval Gate
  +-- Audit Logger
  +-- Bypass Scanner
  |
  v
Protected Database / API / MCP Server
```

Warden's core pipeline classifies and governs action attempts. Adapters feed action metadata and arguments into that pipeline:

- TypeScript SDK guard for app backends and agent tool wrappers
- MCP proxy for MCP clients and upstream MCP servers
- future HTTP sidecar for non-TypeScript and non-MCP stacks

The MCP adapter exposes namespaced tools:

```text
github.create_issue
slack.send_message
filesystem.write_file
postgres.run_query
```

The client should never need an extra parameter like `mcp_name`. Routing is owned by Warden.

## Build Order

### Phase 0: Repository And Contracts

Goal: define the core data types before protocol plumbing.

Deliverables:

- TypeScript package
- CLI entrypoint
- test runner
- formatter/linter
- typed domain models:
  - `ToolRef`
  - `ToolMetadata`
  - `RiskLabel`
  - `PolicyDecision`
  - `ApprovalRequest`
  - `AuditEvent`
  - `EnvironmentStatus`

Success criteria:

- `pnpm test` runs
- domain model tests pass
- no MCP dependency is needed yet

Why first:

The classifier, policy engine, approvals, and audit log are the product. MCP transport is an interface around them.

### Phase 1: Policy Engine And Classifier

Goal: make deterministic decisions from tool metadata and call arguments.

Deliverables:

- YAML policy loader
- default policy
- heuristic classifier
- per-tool overrides
- per-risk defaults
- redaction config
- `warden policy test <call.json>`

Example:

```bash
warden policy test examples/filesystem-write.json
```

Expected output:

```text
decision: require_approval
tool: filesystem.write_file
risk: write,file_mutation
reason: write -> require_approval
```

Success criteria:

- read tools allow by default
- write/destructive/external-send tools require approval
- financial and credential access deny by default
- unknown tools require approval
- every decision includes a human-readable reason

### Phase 2: Audit Logger

Goal: every attempted action creates evidence.

Deliverables:

- JSONL audit writer
- redacted argument storage
- response summary storage
- policy version hash
- `warden audit tail`
- `warden audit inspect <id>`

Success criteria:

- allowed, denied, failed, and approval-required calls are logged
- sensitive fields are redacted according to policy
- audit records are readable without a dashboard

### Phase 3: Approval Gate

Goal: pause risky local actions and make the human decision explicit.

Deliverables:

- blocking terminal approval
- approve/reject/details
- edit-and-approve if simple to implement safely
- timeout handling
- immutable approval record

Success criteria:

- Enter defaults to reject
- timeout rejects
- edited requests preserve original request
- agent cannot approve its own call
- final executed arguments are auditable

### Phase 4: Generic SDK Guard

Goal: make Warden usable without MCP.

Deliverables:

- `guardAction` TypeScript API
- app/backend action metadata shape
- database query example
- tests for read, write, destructive, approval, audit, and executor failure behavior

Success criteria:

- a website chatbot can wrap a database function with Warden
- SQL reads execute under default policy
- SQL writes fail closed without approval
- destructive SQL can be denied before executor invocation

### Phase 5: Fake MCP Harness

Goal: test the product without relying on client-specific behavior.

Deliverables:

- tiny in-repo MCP-like test server or mock adapter
- tools:
  - `filesystem.read_file`
  - `filesystem.write_file`
  - `filesystem.delete_file`
  - `slack.send_message`
- test client that calls Warden directly

Success criteria:

- Warden can classify, approve, deny, forward, and log fake tool calls end to end
- tests cover the dangerous cases before real MCP plumbing lands

### Phase 6: Real MCP Gateway

Goal: become a real MCP server that proxies one upstream MCP server.

Deliverables:

- stdio MCP server exposed by Warden
- stdio upstream MCP client support
- tool list proxying
- namespaced tool names
- call routing
- one upstream server in config

Success criteria:

- an MCP client can connect to Warden
- Warden lists upstream tools
- Warden forwards allowed calls
- Warden blocks denied calls
- Warden approval-gates risky calls

### Phase 7: Multi-Upstream Routing

Goal: one Warden server governs multiple tool families.

Deliverables:

- multiple upstream MCP servers
- namespace collision handling
- per-upstream policy
- tool inventory command

Config shape:

```yaml
upstreams:
  filesystem:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."]

  github:
    transport: stdio
    command: github-mcp-server
    env:
      GITHUB_TOKEN: "${WARDEN_GITHUB_TOKEN}"
```

Success criteria:

- `warden inspect` shows all upstream tools
- namespaced routing is deterministic
- policy can target `upstream.tool`

### Phase 8: HTTP Sidecar

Goal: make Warden usable from any language or agent framework.

Current state: decision-only HTTP support is built through `warden serve` and `POST /v1/decide`. Execute-through adapters remain future work.

Deliverables:

- localhost HTTP decision API - built
- JSON request/response schema for action metadata and arguments - built
- audit-writing decision-only mode - built
- optional execute-through mode for configured adapters
- examples for database-backed chatbot integration

Success criteria:

- a Python, Ruby, Go, or Node app can ask Warden before executing a protected database/API action
- denied actions never reach the protected executor
- audit evidence is written for allowed, denied, failed, and approval-required actions

### Phase 9: Codex Integration

Goal: make Warden easy to use with Codex.

Deliverables:

- `warden setup codex`
- generated Codex MCP config snippet
- recommended Codex permission profile
- `warden doctor codex`

Codex config should point only at Warden:

```toml
[mcp_servers.warden]
command = "warden"
args = ["proxy", "--config", "/path/to/warden.yaml"]
default_tools_approval_mode = "approve"
```

Warden, not Codex, should decide tool-specific approval.

Success criteria:

- Codex sees Warden as an MCP server
- protected upstream MCPs are not directly configured
- `warden doctor codex` warns about direct MCP registrations, exposed env vars, writable policy, and unrestricted network paths

### Phase 10: Claude Code Integration

Goal: make Warden easy to use with Claude Code.

Deliverables:

- `warden setup claude`
- generated `.mcp.json` for local/project use
- generated managed MCP example for team enforcement
- `warden doctor claude`

Project-local config:

```json
{
  "mcpServers": {
    "warden": {
      "type": "stdio",
      "command": "warden",
      "args": ["proxy", "--config", "/path/to/warden.yaml"]
    }
  }
}
```

Team enforcement should document Claude Code managed MCP mode where only Warden is allowed.

Success criteria:

- Claude Code sees Warden as an MCP server
- local mode works for developers
- team mode has a clear path to exclusive Warden-only MCP loading
- `warden doctor claude` flags direct `.mcp.json` upstream registrations

### Phase 11: Bypass Resistance

Goal: distinguish monitoring from enforcement.

Deliverables:

- `warden doctor`
- environment status:
  - `monitoring_only`
  - `partially_enforced`
  - `enforced`
- scans for:
  - direct MCP configs
  - exposed protected env vars
  - writable policy files
  - writable audit logs
  - known protected SDK imports
  - direct protected API hostnames

Success criteria:

- Warden never claims enforcement if the agent still has direct credentials or direct MCP access
- doctor output explains what to fix
- bypass warnings are actionable

### Phase 12: Local Web UI

Goal: make approvals and audits easier without making the MVP dependent on a browser UI.

Deliverables:

- local dashboard
- approval inbox
- audit viewer
- tool inventory viewer
- policy status viewer

Success criteria:

- terminal flow still works
- local web UI is optional
- user can inspect tool calls and approvals without reading JSONL

### Phase 13: Team Product

Goal: turn local Warden into a viable paid product.

Deliverables:

- hosted approval inbox
- Slack approvals
- shared org policy
- searchable audit logs
- SSO
- append-only remote audit storage
- policy drift alerts
- organization tool inventory

Success criteria:

- one team can govern multiple developers and agents
- security/platform teams get visibility without owning every agent implementation
- local-first mode remains available for sensitive workflows

## MVP We Should Actually Ship

The first public MVP should include Phases 0 through 8, with Phase 11 started.

Minimum product:

- Warden CLI
- policy engine
- classifier
- audit log
- terminal approval
- TypeScript SDK guard
- HTTP decision sidecar
- real MCP gateway
- multi-upstream routing
- doctor checks for obvious bypass risk

This is enough to prove the product promise:

```text
Put Warden between your agent and your database/API/tool.
Warden blocks dangerous actions, asks before risky writes, and leaves an audit trail.
```

## What We Should Delay

Delay these until the local MCP gateway works:

- hosted accounts
- billing
- Slack approvals
- model-based classification
- compliance reports
- ChatGPT Sites launch auditor
- complex container sandboxing
- enterprise admin UI

## Initial Repo Structure

```text
warden/
  package.json
  tsconfig.json
  src/
    cli/
    config/
    mcp/
    policy/
    classify/
    approval/
    audit/
    doctor/
    integrations/
      codex/
      claude/
  examples/
    policies/
    calls/
  tests/
  docs/
```

## First Engineering Sprint

Build these in order:

1. package setup
2. domain types
3. policy YAML loader
4. classifier
5. policy decision engine
6. JSONL audit logger
7. `warden policy test`
8. unit tests

Do not start with the full MCP gateway. Start with the decision loop that every gateway call will depend on.
