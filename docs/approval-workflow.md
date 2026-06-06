# Approval Workflow

![Warden action approval flow](assets/warden-openai-flow.svg)

## Goal

Dangerous agent actions should pause at the boundary, show a human exactly what would happen, and resume only after an explicit decision.

The workflow must be fast enough for developers to tolerate, strict enough to prevent accidental damage, and detailed enough to support later investigation.

## What's implemented today

An approval-required call stalls for `approval.timeout` (`0s`/`30s`/`1m`/`5m`/`30m`/`1h`, default `1m`), then fails closed. Use `0s` only when you intentionally want immediate fail-closed behavior. The response channel is `approval.method`:

- **`deny`** — never approves; refuse with a clear message. Zero setup, fully fail-closed.
- **`local`** — an in-process localhost inbox (web page + JSON API) backed by a pending-approval queue. Resolve from the browser or via `warden approvals` / `warden approve <id>` / `warden deny <id>`. The inbox only ever exposes redacted arguments.
- **`telegram`** — DMs the approver a native poll (✅ Approve / ❌ Deny) with the redacted details and resolves it from the bot's long-poll stream (first vote wins, then the poll is closed). Onboard with `warden login --token <bot-token>`: it prints a `t.me/<bot>?start=<code>` deep link, and tapping Start pairs that device. Bot token + approver chat id are stored 0600 in `~/.warden/telegram.json`, never in `warden.yaml`. You bring your own BotFather bot — no Warden backend.
- **`callback`** — a function you supply via `configureWarden({ approval: { onApproval } })`, so you can route to your own UI, Slack, or on-call.

`warden proxy` (the MCP gateway) keeps its interactive `/dev/tty` terminal prompt; `approval.method` governs the SDK/`configureWarden` paths. The queue is the core primitive, so notification channels and suspend/resume can be added later without changing policy semantics.

Tool-specific `approval.approvers` and `approval.require_reason` are enforced after a reviewer responds. Telegram poll approvals cannot provide a reason, so policies with `require_reason: true` need a local or callback approval channel.

The rest of this document is the design rationale behind that behavior.

## Decision Types

Warden policy can return:

- `allow`: run immediately
- `deny`: block immediately
- `require_approval`: create an approval request and pause the call
- `redact_then_allow`: redact configured fields and run
- `transform_then_allow`: constrain or rewrite arguments and run

This document focuses on `require_approval`.

## Approval Request Lifecycle

```text
tool call received
  |
  v
classify risk
  |
  v
evaluate policy
  |
  v
create approval request
  |
  +-- notify human
  |
  +-- agent receives pending response or waits
  |
  v
human approves, rejects, edits, or expires
  |
  v
Warden executes approved call or returns rejection
  |
  v
audit event is finalized
```

## Approval Request Fields

Each request should include:

- approval id
- run id
- call id
- created timestamp
- expiration timestamp
- client identity
- agent identity
- user identity if known
- upstream server
- tool name
- risk labels
- policy rule that triggered approval
- original arguments
- redacted human display arguments
- expected side effect
- classifier explanation
- recent context summary if available
- status

Valid statuses:

- `pending`
- `approved`
- `rejected`
- `edited_and_approved`
- `expired`
- `cancelled`
- `failed`

## Human Actions

The reviewer should have four choices:

### Approve

Run exactly the originally requested tool call.

Use when the request is safe, expected, and correctly scoped.

### Reject

Block the call and return a structured rejection to the agent.

Use when the action is unsafe, unnecessary, too broad, or based on bad context.

### Edit And Approve

Modify arguments before execution.

Examples:

- reduce a file glob
- remove an external recipient
- change a production database to staging
- limit a date range
- remove sensitive fields from a payload

Every edit must preserve the original request in the audit log.

### Always Allow Similar

Create a policy suggestion, not an immediate silent policy change.

This option should show the exact proposed rule and require confirmation. In team mode, it may require policy-owner approval.

## Agent-Facing Behavior

MCP clients may not all support asynchronous approvals cleanly. Warden should support two modes.

### Blocking Mode

Warden holds the tool call open while waiting for approval.

Best for:

- local developer workflows
- terminal approval
- short timeout windows

Downside:

- client may time out

### Pending Token Mode

Warden immediately returns a structured pending response:

```json
{
  "status": "pending_approval",
  "approval_id": "appr_123",
  "message": "This action requires human approval."
}
```

The agent can later call a Warden status tool:

```text
warden.get_approval_status
```

Best for:

- web UI
- long-running workflows
- Slack/email approvals

Downside:

- requires the agent/client to understand the pending flow

## Recommended MVP Behavior

For v0.1, use blocking mode with a terminal prompt.

Reasons:

- simplest to implement
- easiest to test
- no separate approval inbox required
- good fit for local coding-agent workflows

If the client times out or Warden loses the approval session, fail closed and mark the request `expired` or `failed`.

## Terminal Prompt

The first approval UI should be compact and explicit:

```text
Warden approval required

Tool: filesystem.write_file
Risk: write, file_mutation
Policy: write -> require_approval
Reason: Tool can modify files.

Arguments:
  path: src/config.ts
  content: <2,148 chars>

Approve? [a]pprove / [r]eject / [e]dit / [d]etails
```

The default action on Enter should be reject.

## Timeouts

Every approval request must expire.

Suggested defaults:

- local terminal approval: 120 seconds
- Slack/email approval: 15 minutes
- production destructive action: 5 minutes

On expiration:

- do not execute the call
- return a structured rejection or timeout to the agent
- write an audit event

## Approval Policies

Policy should support:

```yaml
tools:
  filesystem.write_file:
    decision: require_approval
    approval:
      timeout_seconds: 120
      approvers:
        - local_user

  github.merge_pull_request:
    decision: require_approval
    approval:
      approvers:
        - repo_owner
      require_reason: true
```

Team mode should support approval rules by:

- risk label
- tool name
- upstream server
- environment
- requester
- path or resource pattern
- dollar amount
- data sensitivity

## Audit Requirements

Approval audit records must include:

- original request
- displayed request after redaction
- final executed request
- decision
- approver identity
- approval timestamp
- policy version
- reason if provided
- timeout or failure details

Edits must be diffable.

## Safety Rules

- Deny by default if approval infrastructure is unavailable.
- Do not let the agent approve its own request.
- Do not allow prompt text to define approvers.
- Do not auto-approve based only on model confidence.
- Do not hide rejected calls from the audit log.
- Do not execute edited requests without recording the original request.
- Require reapproval if arguments change after approval.

## Avoiding Approval Fatigue

Approvals should be reserved for meaningful risk.

Ways to reduce noise:

- allow known read-only calls by default
- support path/resource allowlists
- support per-session temporary grants
- batch related low-risk writes into one approval
- let users create narrow policy rules from repeated approvals
- show concise diffs instead of full payloads when possible

Temporary grants should be scoped:

```yaml
grant:
  tool: filesystem.write_file
  path_prefix: docs/
  duration_minutes: 30
  max_calls: 20
```

## Future Approval Channels

After terminal approval works, add:

- local web inbox
- Slack approval buttons
- email approval links
- GitHub check comments
- mobile push
- team dashboard

The terminal flow should remain available because it is the most trustworthy local fallback.
