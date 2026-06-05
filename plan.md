# Warden Plan

## Current Product Definition

Warden is an action-control layer for AI agents.

The product goal is to sit between any agent and real tools, APIs, databases, or production systems, classify every action, enforce policy, require approval for risky actions, and write useful audit evidence. Warden should eventually also reduce bypass paths by owning credentials, policy, audit storage, and the network route to protected systems.

## What Is Built

### Core Project

- TypeScript package and CLI scaffold.
- Strict TypeScript configuration.
- Clean build before tests to avoid stale compiled artifacts.
- Minimal dependency surface:
  - production: `yaml`
  - dev: `typescript`, `@types/node`

### Policy And Classification

- YAML policy parser.
- Secure default decisions:
  - read: allow
  - write: require approval
  - destructive: require approval
  - external send: require approval
  - code execution: require approval
  - file mutation: require approval
  - network egress: require approval
  - credential access: deny
  - financial: deny
  - sensitive data: require approval
  - unknown: require approval
- Deterministic classifier for tool names, descriptions, schemas, annotations, SQL, and bounded argument values.
- Suspicious metadata detection for prompt-injection-like tool descriptions.
- Deny-risk precedence so sensitive/financial/credential risks cannot be weakened by ordinary tool-specific approval rules.

### Audit And Redaction

- JSONL audit event creation and append.
- Redaction for configured sensitive fields.
- Default redaction fields are always retained even when users add custom fields.
- Secret-looking substrings are scrubbed inside larger string values.
- Audit events include decision, policy rule, risk labels, request args, executed args when applicable, response status, duration, and errors.

### Approval Core

- Approval request creation.
- Approve, reject, edit-and-approve, expire, and failure semantics.
- Approval timeout fails closed.
- Edited arguments preserve the original request and are reclassified before execution.
- Terminal reviewer supports approve, reject, edit-and-approve, and details.
- `warden proxy` opens a `/dev/tty` terminal approval side channel when available, keeping MCP protocol traffic isolated to stdin/stdout.
- If no terminal side channel is available, approval-required proxy calls still fail closed.

### Tool-Call Pipeline

- End-to-end handler:
  - classify
  - evaluate policy
  - require approval if needed
  - execute allowed/approved calls
  - block denied/rejected/expired calls
  - write audit event when an audit path is supplied
- Upstream execution errors are preserved as upstream errors, not converted into Warden policy blocks.

### Generic SDK

- `guardAction` TypeScript API for app backends and agent tool wrappers.
- App code can guard arbitrary actions without MCP:
  - database queries
  - internal API calls
  - admin operations
  - external sends
  - billing actions
- SQL `SELECT` calls can run immediately under default policy.
- SQL writes fail closed without approval.
- Destructive SQL can be hard-denied before the database executor runs.

### MCP Gateway

- Minimal newline-delimited JSON-RPC transport.
- Minimal MCP stdio gateway exposed by `warden proxy`.
- Supported methods:
  - `initialize`
  - `notifications/initialized`
  - `ping`
  - `tools/list`
  - `tools/call`
- Stdio upstream MCP client.
- Multiple stdio upstreams can be configured.
- Upstream tools are exposed as namespaced tools such as `filesystem.write_file`.
- `tools/call` routes through Warden policy/audit pipeline.
- Approval-required calls pause for terminal review in `warden proxy` when `/dev/tty` is available.
- Approval-required calls fail closed in non-interactive proxy sessions without an approval side channel.

### CLI

- `warden init`
- `warden policy test`
- `warden audit tail`
- `warden doctor`
- `warden inspect`
- `warden setup codex`
- `warden setup claude`
- `warden proxy`
- `pnpm run compat:clients`

### Doctor Checks

- Flags direct Claude Code project MCP registrations.
- Flags direct Codex project MCP registrations.
- Flags workspace-local `.env`.
- Flags workspace-local `warden.yaml`.
- Flags protected credential environment variables.
- Does not claim full enforcement locally.

### Tests

- Unit tests for classifier, policy config, policy engine, redaction, audit, approvals, tool refs, fixtures, doctor, JSON-RPC, gateway, and pipeline.
- SDK guard tests for app/database integration.
- CLI tests.
- CLI inspect tests against a fake upstream MCP process.
- CLI proxy integration test that spawns `warden proxy`, talks MCP over stdio, proxies to a fake upstream process, allows read calls, blocks approval-required write calls without a reviewer, and executes approval-required calls after side-channel approval.
- Client compatibility smoke script for Codex and Claude Code MCP registration using temporary config.
- Manual model-driven Codex smoke verified an allowed read call through `warden proxy`.

Current verification target:

```bash
pnpm test
pnpm run typecheck
```

## What Is Left

### Immediate Next Milestone: Language-Neutral Action Boundary

`guardAction` makes Warden usable inside TypeScript app backends. The next useful milestone is a language-neutral local HTTP sidecar so any agent framework or web app can ask Warden to authorize an action before touching a database or protected API.

Expected behavior:

- app sends action metadata and arguments to Warden over localhost HTTP
- Warden returns allow, deny, or require-approval decision
- optional execute-through mode calls a configured protected action adapter
- decision-only mode lets the app enforce locally while still writing audit evidence
- works for non-MCP agents and non-TypeScript stacks

### Database Protection

Still needed:

- richer SQL parsing beyond deterministic keyword heuristics
- database-specific policy templates for Postgres, MySQL, and SQLite
- row/table allowlists and denylists
- production/staging environment labels
- explicit bulk-export and cross-tenant data-access detection

### MCP Compatibility

The current MCP gateway is intentionally minimal.

Still needed:

- tool-list pagination support
- cancellation
- progress notifications
- resources
- prompts
- streamable HTTP transport
- better MCP protocol version negotiation
- compatibility testing against real Codex and Claude Code clients

### Upstream Management

Still needed:

- env interpolation from Warden-owned variables or secret store
- safer environment forwarding
- upstream restart/backoff
- graceful shutdown and child-process cleanup hardening
- startup failure diagnostics
- per-upstream enable/disable

### Bypass Resistance

Still needed:

- user-level Codex config scanning
- user-level Claude config scanning
- code scanning for direct protected SDK imports and hostnames
- detection of direct API keys in project files
- `warden exec` to launch agents with scrubbed env/config
- network egress controls
- sandbox/container mode
- clearer `monitoring_only`, `partially_enforced`, and `enforced` status logic

### Audit Hardening

Still needed:

- append-only local log option
- hash chaining
- remote audit sink
- log rotation
- size limits
- malformed log recovery
- stable run IDs across a single agent run

### Product Surface

Still needed:

- local web UI
- approval inbox
- audit viewer
- tool inventory viewer
- policy editor/tester
- Codex/Claude setup docs verified against real clients
- hosted/team product
- SSO and team policy ownership

## Known Current Limitations

- The classifier is heuristic and conservative, not complete.
- The redactor catches common token patterns, not every possible secret.
- MCP support is enough for a controlled prototype, not full protocol coverage.
- `warden proxy` terminal approval requires an available `/dev/tty`; non-interactive sessions fail closed.
- Local doctor checks are shallow and do not prove enforcement.
- Warden still cannot stop bypass if the agent has direct credentials, network, or writable config access.

## Recommended Build Order

1. Add a localhost HTTP decision sidecar for non-MCP and non-TypeScript apps.
2. Add database-specific policy templates and stronger SQL classification.
3. Improve doctor scans for direct database/API bypass paths.
4. Add `warden exec` environment scrubber.
5. Add local web approval/audit UI.
6. Continue MCP/client compatibility based on actual user demand.
