# Implementation Status

## Built

The current codebase includes the local product core:

- TypeScript package and CLI scaffold
- deterministic risk classifier
- YAML policy parser and secure defaults
- policy engine with deny-risk precedence
- redaction of sensitive argument fields
- JSONL audit logger
- approval request and resolution core
- terminal approval reviewer
- end-to-end fake tool-call pipeline
- minimal stdio MCP gateway
- stdio upstream MCP client
- `/dev/tty` approval side channel for `warden proxy`
- `warden inspect` upstream tool inventory with risk labels and policy decisions
- client compatibility smoke check for Codex and Claude Code MCP registration
- basic `warden doctor`
- Codex and Claude Code setup snippet generation
- example policies and tool-call fixtures

## Recent Hardening

The review pass fixed several important issues:

- Audit redaction now scrubs common token-like secrets inside string values, not only fields named `token` or `password`.
- User redaction config now merges with default secret fields instead of replacing them.
- The classifier now inspects bounded string argument values for URLs, webhooks, email destinations, and token-like secrets.
- Suspicious MCP metadata such as "ignore previous instructions" now forces review by adding `unknown`.
- `warden doctor` now flags protected credential environment variables.
- `warden proxy` now serves a minimal MCP stdio gateway.

## Current Commands

```bash
pnpm test
pnpm run build
pnpm run compat:clients

node dist/src/cli/index.js init
node dist/src/cli/index.js policy test examples/calls/filesystem-write.json --config examples/policies/warden.yaml
node dist/src/cli/index.js policy test examples/calls/stripe-refund.json --config examples/policies/warden.yaml --json
node dist/src/cli/index.js audit tail
node dist/src/cli/index.js doctor --json
node dist/src/cli/index.js inspect --config warden.yaml
node dist/src/cli/index.js setup codex --config examples/policies/warden.yaml
node dist/src/cli/index.js setup claude --config examples/policies/warden.yaml
node dist/src/cli/index.js proxy --config warden.yaml
```

## Verified Behavior

- Read-only tools allow by default.
- Write and file mutation tools require approval by default.
- Destructive tools require approval by default.
- Financial tools deny by default.
- Credential access denies by default.
- Unknown tools require approval by default.
- Deny-risk defaults outrank non-deny tool-specific decisions.
- Approval requests expire fail-closed.
- Rejected approvals do not execute.
- Edited approvals preserve original and final arguments.
- Edited approval arguments are rechecked before execution.
- Audit logs redact configured sensitive fields.
- Audit logs redact common secret-looking substrings inside larger string values.
- Suspicious tool metadata requires review.
- URL and webhook argument values raise network/external-send risk.
- Doctor flags direct MCP configs as monitoring-only.
- Doctor flags exposed protected environment variables as monitoring-only.
- `warden inspect` initializes configured upstreams and prints namespaced tools, descriptions, risk labels, and policy decisions.
- `pnpm run compat:clients` verifies Warden MCP registration with installed Codex and Claude Code CLIs using temporary config.
- `warden proxy` can initialize, list namespaced upstream tools, route allowed calls, block policy-denied calls, and execute approval-required calls after terminal side-channel approval.
- `warden proxy` still fails closed on approval-required calls when no terminal side channel is available.

## Not Built Yet

- `warden exec`
- containerized sandboxing
- model-driven Codex and Claude Code tool-call smoke tests
- local web approval inbox
- hosted team product

## Next Engineering Step

Test model-driven Warden tool calls through Codex and Claude Code:

1. Use generated setup snippets or temp config to point each client at Warden.
2. Ask each client to call an allowed fake read tool through Warden.
3. Confirm denied and approval-required calls behave correctly.
4. Convert real compatibility failures into focused MCP gateway fixes.
