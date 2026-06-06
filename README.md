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

The core product is an action boundary:

1. Put Warden between an agent and a protected tool, API, or database.
2. Warden classifies each action using tool metadata and arguments.
3. Warden allows, blocks, or asks for approval based on policy.
4. Warden logs a human-readable audit trail for every action.
5. Use MCP, the TypeScript SDK, or future adapters to connect different agent stacks.

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
- [Generic Action Boundary](docs/generic-action-boundary.md)
- [Expected Behavior](docs/expected-behavior.md)
- [MVP Plan](docs/mvp-plan.md)
- [Build Plan](docs/build-plan.md)
- [Implementation Status](docs/implementation-status.md)
- [MCP Gateway](docs/mcp-gateway.md)
- [Client Compatibility](docs/client-compatibility.md)
- [Product Strategy](docs/product-strategy.md)
- [Security Model](docs/security-model.md)
- [Approval Workflow](docs/approval-workflow.md)

## Quickstart

```bash
pnpm install
pnpm test
pnpm run build
pnpm run compat:clients
```

Try the current policy engine:

```bash
node dist/src/cli/index.js policy test examples/calls/filesystem-write.json --config examples/policies/warden.yaml
node dist/src/cli/index.js policy test examples/calls/stripe-refund.json --config examples/policies/warden.yaml --json
node dist/src/cli/index.js doctor --json
```

Run the local HTTP decision sidecar for non-TypeScript and non-MCP integrations:

```bash
node dist/src/cli/index.js serve --config examples/policies/warden.yaml --port 8787
curl -s http://127.0.0.1:8787/v1/decide \
  -H 'Content-Type: application/json' \
  -d '{"tool":"database.run_sql","description":"Run SQL against the app database","arguments":{"sql":"select id from users limit 1"}}'
```

The sidecar returns the policy decision, risk classification, audit event, and `forwardArguments` when the app may execute the action itself.

Use Warden inside an app backend:

```ts
import { defaultPolicyConfig, guardAction } from "warden";

const policy = defaultPolicyConfig();
policy.defaults.destructive = "deny";

const result = await guardAction({
  config: policy,
  tool: "database.run_sql",
  description: "Run SQL against the production application database",
  arguments: { sql: "drop table users" },
  execute: async (args) => db.query(String(args.sql)),
});

if (!result.executed) {
  throw new Error(result.error);
}
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
