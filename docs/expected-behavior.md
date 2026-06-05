# Expected Behavior

This document defines how Warden should behave from the user's point of view.

## Primary User Story

A developer has an AI agent or chatbot connected to real capabilities: database queries, internal APIs, MCP tools, billing actions, or admin operations. Some actions are safe to call freely, some mutate state, and some could cause real harm if misused. The developer puts Warden between the agent and those capabilities so every action is classified, policy-checked, logged, and optionally approved by a human.

## First-Time Setup

Expected behavior:

1. User installs Warden.
2. User wraps backend actions with the SDK, configures the MCP proxy, or points a future sidecar at protected actions.
3. Warden receives action metadata and arguments.
4. Warden generates an initial policy file.
5. User edits the policy or accepts defaults.
6. User points the agent or app tool wrapper at Warden.
7. Agent continues to act through the app, but protected calls pass through Warden.

Default posture:

- Read-only tools are allowed.
- Write tools require approval unless explicitly allowed.
- Destructive tools require approval by default.
- External-send tools require approval by default.
- Payment, credential, production database, and bulk-export tools are denied until explicitly configured.
- Unknown or newly changed tools require review.

## Action Inventory

When an app, SDK wrapper, or upstream MCP server exposes actions, Warden should show:

- source or adapter name
- tool name
- tool description
- input schema
- annotations if available
- inferred risk level
- reason for classification
- policy outcome
- first seen timestamp
- last changed timestamp

If a tool description or schema changes, Warden treats it as a new review event.

## Risk Classification

Warden should classify tool calls into practical categories:

- `read`: retrieves information without changing state
- `write`: creates or updates state
- `destructive`: deletes, overwrites, resets, disables, revokes, or removes records
- `external_send`: sends data outside the local system, such as email, Slack, webhooks, forms, or tickets
- `code_execution`: runs commands, scripts, notebooks, browser automation, or generated code
- `file_mutation`: creates, edits, moves, or deletes files
- `network_egress`: calls external URLs or APIs
- `credential_access`: reads, creates, changes, or uses secrets, tokens, keys, or auth sessions
- `financial`: purchases, transfers, invoices, refunds, subscriptions, payouts, or payment setup
- `sensitive_data`: accesses or transmits personal, customer, health, financial, legal, or confidential company data

Classification should use metadata first, policy overrides second, and heuristic inference third.

## Policy Decisions

Each tool call should result in one of these decisions:

- `allow`: call is forwarded immediately
- `deny`: call is blocked and the agent receives a safe refusal
- `require_approval`: call is paused until a human decides
- `redact_then_allow`: sensitive fields are redacted before forwarding
- `transform_then_allow`: arguments are normalized or constrained before forwarding

Every decision must include a reason.

## Approval Flow

When approval is required, Warden should show the human:

- agent identity
- user identity if known
- requested tool
- proposed arguments
- risk labels
- policy rule that triggered approval
- relevant context summary
- expected side effect
- options to approve, reject, or edit arguments

The agent should receive a pending response or be blocked until approval resolves, depending on client capabilities.

Approval records should include:

- approver
- timestamp
- original request
- edited request if any
- reason or comment
- final action

## Audit Log

Every attempted tool call should be logged, including denied and failed calls.

Minimum log fields:

- run id
- call id
- timestamp
- client
- agent
- user
- upstream server
- tool
- risk labels
- policy version
- decision
- approval id if applicable
- request arguments, with redactions marked
- response summary
- response status
- duration
- error if any

Logs should be useful to a human investigating an incident six months later.

## Agent-Facing Behavior

Warden should not leak internal policy details that help bypass controls.

For denied calls, the agent should receive a short structured error:

```json
{
  "error": "tool_call_denied",
  "message": "This action is blocked by policy.",
  "decision_id": "dec_..."
}
```

For approval-required calls, the agent should receive a structured pending or rejected response. If the client cannot support async approval, Warden should fail closed.

## Suspicious Metadata

Warden should flag tool metadata that appears to include:

- hidden instructions to the model
- attempts to override system or developer instructions
- requests to hide tool usage from the user
- unusually persuasive descriptions
- mismatch between name and behavior
- schema fields that imply hidden destinations or credentials

Suspicious metadata should require review before the tool can be used.

## Failure Modes

Warden must fail closed for high-risk cases.

Expected behavior:

- If policy cannot be loaded, deny non-read calls.
- If classification fails, require approval.
- If approval backend is unavailable, deny approval-required calls.
- If logging fails, deny high-risk calls and warn for low-risk calls.
- If upstream tool schemas change unexpectedly, require review.
- If identity is missing for a privileged action, deny.

## Bypass Resistance

Warden should make bypass status visible.

If the agent environment still contains direct upstream credentials, direct MCP registrations, writable Warden policy, writable audit logs, or unrestricted network access to protected services, Warden should mark the setup as `monitoring_only`.

If Warden owns the credentials, policy, audit path, and network route to protected services, Warden may mark the setup as `enforced`.

For coding agents, Warden should prefer a sandbox model where:

- the agent can edit project code
- Warden runs outside the writable workspace
- upstream credentials are not available to the agent
- protected services are reachable only through Warden
- policy and audit logs are not writable by the agent
- generated code is scanned for direct protected-service access before deployment

## Product Boundary

Warden is responsible for action authorization, policy, approvals, and audit evidence.

Warden is not responsible for guaranteeing that a model's final answer is true, that an external API is correct, or that a human-approved action is wise. It should make risk visible and enforce configured controls.
