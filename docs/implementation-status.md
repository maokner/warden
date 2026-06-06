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
- generic `guardAction` TypeScript SDK for app backends and agent tool wrappers
- end-to-end fake tool-call pipeline
- minimal stdio MCP gateway
- stdio upstream MCP client
- `/dev/tty` approval side channel for `warden proxy`
- `warden inspect` upstream tool inventory with risk labels and policy decisions
- client compatibility smoke check for Codex and Claude Code MCP registration
- basic `warden doctor`
- Codex and Claude Code setup snippet generation
- localhost HTTP decision sidecar for non-TypeScript and non-MCP integrations
- example policies and tool-call fixtures

## Recent Hardening

The review pass fixed several important issues:

- Audit redaction now scrubs common token-like secrets inside string values, not only fields named `token` or `password`.
- User redaction config now merges with default secret fields instead of replacing them.
- The classifier now inspects bounded string argument values for URLs, webhooks, email destinations, and token-like secrets.
- Suspicious MCP metadata such as "ignore previous instructions" now forces review by adding `unknown`.
- `warden doctor` now flags protected credential environment variables.
- `guardAction` can protect arbitrary backend functions without MCP.
- `warden proxy` now serves a minimal MCP stdio gateway.
- Key-value redaction now handles values containing `s` and is idempotent for existing `[REDACTED]` markers.
- `redact_then_allow` now forwards redacted arguments instead of original arguments.
- `transform_then_allow` now fails closed until concrete transform rules are implemented.
- `warden serve` now exposes `POST /v1/decide` for local HTTP decision-only integrations.

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
node dist/src/cli/index.js serve --config examples/policies/warden.yaml --port 8787
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
- `redact_then_allow` forwards redacted arguments to protected executors and audit evidence.
- `transform_then_allow` refuses execution until a transform implementation exists.
- Suspicious tool metadata requires review.
- URL and webhook argument values raise network/external-send risk.
- SQL `SELECT` actions can execute through `guardAction`.
- SQL writes fail closed through `guardAction` when no reviewer is configured.
- Destructive SQL can be hard-denied before the database function executes.
- Doctor flags direct MCP configs as monitoring-only.
- Doctor flags exposed protected environment variables as monitoring-only.
- `warden inspect` initializes configured upstreams and prints namespaced tools, descriptions, risk labels, and policy decisions.
- `pnpm run compat:clients` verifies Warden MCP registration with installed Codex and Claude Code CLIs using temporary config.
- Codex CLI `0.137.0` can call the allowed fake read tool through `warden proxy` in an ephemeral model-driven session.
- `warden proxy` can initialize, list namespaced upstream tools, route allowed calls, block policy-denied calls, and execute approval-required calls after terminal side-channel approval.
- `warden proxy` still fails closed on approval-required calls when no terminal side channel is available.
- `warden serve` accepts action metadata and arguments over localhost HTTP and returns allow, deny, or require-approval decisions with audit evidence.

## Not Built Yet

- `warden exec`
- execute-through HTTP adapters for configured protected actions
- database-specific policy templates and stronger SQL classification
- containerized sandboxing
- model-driven Claude Code tool-call smoke test
- model-driven denied and approval-required client smoke tests
- local web approval inbox
- hosted team product

## Next Engineering Step

Add database-focused protection on top of the new language-neutral action boundary:

1. Add database-focused policy templates.
2. Strengthen SQL classification beyond keyword heuristics.
3. Add table/operation allowlists and environment labels.
4. Add bypass scans for direct database credentials and SDK imports.
