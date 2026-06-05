# Warden

Warden is an action-control layer for AI agents.

Agents are quickly gaining the ability to call tools, publish sites, send messages, edit files, update databases, and complete purchases. The problem is no longer only "can we build an agent?" The harder question is "can we trust this agent to act safely in production?"

Warden sits between agents and tools. It classifies tool calls, enforces least-privilege policy, captures audit evidence, and requires human approval for risky actions.

## Product Thesis

Agent builders will become plentiful and cheap. The durable product opportunity is the trust layer:

- What is this agent allowed to do?
- Which actions require approval?
- Who approved a risky action?
- What exact tool call ran?
- What data crossed the boundary?
- Can we replay or explain the run later?
- Can we stop a compromised or confused agent before damage happens?

## Initial Wedge

The first product is an MCP action firewall:

1. Run Warden as a local or hosted proxy in front of MCP servers.
2. Point an MCP-compatible client at Warden instead of directly at tools.
3. Warden inspects each tool list, tool description, input schema, and tool call.
4. Warden allows, blocks, or asks for approval based on policy.
5. Warden logs a human-readable audit trail for every action.

## Target Users

- Developers building agents with MCP, OpenAI Agents SDK, LangGraph, CrewAI, Cursor, Claude Code, Codex, or internal automation tools.
- Small teams that want agents to touch real systems without giving them broad unrestricted access.
- Security and platform teams that need visibility into agent tool usage before agent deployments scale.

## Non-Goals

- Warden is not a generic agent builder.
- Warden is not a replacement for LangSmith, Langfuse, Braintrust, or Phoenix.
- Warden is not a generic no-code workflow platform.
- Warden does not try to judge all model quality. It focuses on action safety, policy enforcement, approvals, and auditability.

## Docs

- [Product Overview](docs/product-overview.md)
- [Expected Behavior](docs/expected-behavior.md)
- [MVP Plan](docs/mvp-plan.md)
- [Build Plan](docs/build-plan.md)
- [Implementation Status](docs/implementation-status.md)
- [MCP Gateway](docs/mcp-gateway.md)
- [Product Strategy](docs/product-strategy.md)
- [Security Model](docs/security-model.md)
- [Approval Workflow](docs/approval-workflow.md)

## Quickstart

```bash
pnpm install
pnpm test
pnpm run build
```

Try the current policy engine:

```bash
node dist/src/cli/index.js policy test examples/calls/filesystem-write.json --config examples/policies/warden.yaml
node dist/src/cli/index.js policy test examples/calls/stripe-refund.json --config examples/policies/warden.yaml --json
node dist/src/cli/index.js doctor --json
```

Inspect configured upstream tools before connecting an agent:

```bash
node dist/src/cli/index.js inspect --config warden.yaml
node dist/src/cli/index.js inspect --config warden.yaml --json
```

Generate client setup snippets:

```bash
node dist/src/cli/index.js setup codex --config examples/policies/warden.yaml
node dist/src/cli/index.js setup claude --config examples/policies/warden.yaml
```

Run the MCP gateway after adding at least one `upstreams` entry to `warden.yaml`:

```bash
node dist/src/cli/index.js proxy --config warden.yaml
```

`warden proxy` uses stdin/stdout only for MCP protocol traffic. Risky calls that require approval are shown on `/dev/tty` when a terminal is available; non-interactive sessions without that side channel fail closed.
