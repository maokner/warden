# MVP Plan

## MVP Goal

Build the smallest useful version of Warden that can sit between Codex or Claude Code and upstream MCP tools, classify tool calls, enforce policy, require approval for risky calls, write an audit log, and warn when the environment is only monitoring instead of truly enforced.

## Version 0.1

### Features

- TypeScript CLI: built
- policy engine: built
- deterministic risk classifier: built
- YAML policy file: built
- static risk overrides: built
- JSONL audit log: built
- terminal approval prompt: built
- fake MCP harness for end-to-end tests: built
- MCP proxy for one upstream MCP server
- multi-upstream routing after the single-upstream path works
- tool inventory
- allow, deny, and require-approval decisions: built
- redaction for configured argument fields: built
- fail-closed behavior for high-risk uncertainty: built
- Codex setup helper: built
- Claude Code setup helper: built
- basic bypass scanner: started
- terminal side-channel approval in `warden proxy`: built
- tool inventory through `warden inspect`: built
- Codex and Claude Code MCP registration smoke check: built
- model-driven Codex allowed-read smoke check: built

### Out of Scope

- hosted dashboard
- multi-tenant auth
- Slack approvals
- browser UI
- advanced anomaly detection
- full compliance report generation
- model-based classification
- Slack/email approval channels
- hard container sandboxing
- billing

## Example Policy

```yaml
defaults:
  read: allow
  write: require_approval
  destructive: require_approval
  external_send: require_approval
  financial: deny
  credential_access: deny

tools:
  filesystem.read_file:
    decision: allow
  filesystem.write_file:
    decision: require_approval
  filesystem.delete_file:
    decision: deny

redaction:
  fields:
    - password
    - token
    - api_key
    - secret
```

## Proposed CLI

```bash
warden init
warden policy test examples/tool-call.json
warden inspect --config warden.yaml
warden proxy --config warden.yaml
warden audit tail
warden doctor
warden setup codex
warden setup claude
```

## Architecture

```text
AI Client
   |
   v
Warden MCP Endpoint
   |
   +-- Tool Inventory
   +-- Risk Classifier
   +-- Policy Engine
   +-- Approval Gate
   +-- Audit Logger
   |
   v
Upstream MCP Servers
```

## Initial Implementation Decisions

- Use TypeScript for the first implementation because MCP server/client examples and agent tooling are strong in Node.
- Store audit logs as JSONL locally.
- Store policy as YAML.
- Keep the approval flow terminal-based for v0.1.
- Use deterministic classification first. Add model-assisted classification only after the policy engine is solid.
- Start with the policy/classifier/audit loop before real MCP protocol work.
- Treat environments as `monitoring_only` unless Warden owns credentials, policy, audit storage, and the route to protected tools.

## Success Criteria

Warden v0.1 is useful if a developer can:

1. Run `warden policy test` against sample calls.
2. Connect Warden to at least one real MCP server.
3. Point Codex or Claude Code at Warden.
4. See all discovered tools and risk labels.
5. Allow read-only calls without friction.
6. Stop destructive calls by default.
7. Approve a write call intentionally.
8. Review an audit log that explains what happened.
9. Run `warden doctor` and see whether the setup is monitoring-only or enforced.

Current gap: `warden proxy` still needs model-driven Claude Code testing plus denied and approval-required client smoke tests.

## Approval MVP

Use blocking terminal approval first.

When a call requires approval, Warden should:

1. classify the call
2. create an approval record
3. show a terminal prompt with tool, risks, policy reason, and arguments
4. allow approve, reject, edit, or details
5. default to reject on empty input
6. expire the approval after a short timeout
7. execute only the approved call
8. write the final decision to the audit log

## Viability Path

### Open Source Wedge

Release the local proxy and policy engine as open source. This builds trust because developers will not route sensitive agent calls through a closed black box before they understand the product.

### Paid Team Layer

Charge for collaboration and governance:

- hosted approval inbox
- shared policy registry
- Slack approvals
- SSO
- searchable audit logs
- compliance exports
- drift alerts
- organization-wide tool inventory

### Product Expansion

After the MCP firewall works, add:

- ChatGPT Sites launch audit
- agent run replay and regression testing
- MCP server supply-chain scanner
- policy templates for common stacks
- production incident reports

## Open Questions

- Which client should be the first polished integration target: Codex or Claude Code?
- Should policy be deny-by-default for all writes, or approval-by-default?
- How much of the audit payload should be stored locally by default versus redacted?
- Should the hosted product ever see tool arguments, or only metadata and hashes?
- Should `warden exec` use a lightweight environment scrubber first or jump straight to containerized sandboxing?
