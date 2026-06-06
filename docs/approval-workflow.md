# Approval Workflow

![Warden action approval flow](assets/warden-openai-flow.svg)

## Goal

Dangerous agent actions should pause at the boundary, show a human exactly what would happen, and resume only after an explicit decision — fast enough for developers to tolerate, strict enough to prevent accidental damage, and detailed enough to support later investigation.

## What's Implemented Today

An approval-required call stalls for `approval.timeout` (`0s`/`30s`/`1m`/`5m`/`30m`/`1h`, default `1m`), then fails closed. Use `0s` only when you intentionally want immediate fail-closed behavior. How a human responds is the `approval.method`:

- **`telegram`** (default) — DMs the approver a native poll (✅ Approve / ❌ Deny) with the redacted details and resolves it from the bot's long-poll stream (first vote wins, then the poll is closed). Onboard with `warden login --token <bot-token>`: it prints a `t.me/<bot>?start=<code>` deep link, and tapping Start pairs that device. Bot token + approver chat id are stored `0600` in `~/.warden/telegram.json`, never in `warden.yaml`. You bring your own BotFather bot — there is no Warden backend.
- **`callback`** — a function you supply via `configureWarden({ approval: { onApproval } })`, so you can route to your own UI, Slack, or on-call. This is the only channel that can **edit-and-approve** or supply a reason.
- **`deny`** — never approves; refuse with a clear message. Zero setup, fully fail-closed.

Tool-specific `approval.approvers` and `approval.require_reason` are enforced after a reviewer responds. Telegram poll approvals cannot provide a reason, so policies with `require_reason: true` need a `callback` channel.

## Decision Types

Warden policy can return:

- `allow`: run immediately
- `deny`: block immediately
- `require_approval`: create an approval request and pause the call
- `redact_then_allow`: redact configured fields and run
- `transform_then_allow`: reserved; currently fails closed until transforms are implemented

This document focuses on `require_approval`.

## Approval Request Lifecycle

```text
tool call received
  -> classify risk
  -> evaluate policy
  -> create approval request (redacted display arguments)
  -> notify the human (Telegram poll / your callback)
  -> human approves, rejects, edits, or the request expires
  -> Warden executes the approved call or returns a rejection
  -> audit event is finalized
```

## Approval Request Fields

Each request includes: approval id, run id, call id, created + expiration timestamps, client/agent/user identity (when known), tool name, risk labels, the policy rule that triggered approval, original arguments, redacted display arguments, and status.

Valid statuses: `pending`, `approved`, `rejected`, `edited_and_approved`, `expired`, `cancelled`, `failed`.

## Human Actions

### Approve

Run exactly the originally requested tool call. Use when the request is safe, expected, and correctly scoped.

### Reject

Block the call and return a structured rejection to the agent. Use when the action is unsafe, unnecessary, too broad, or based on bad context.

### Edit And Approve

Modify arguments before execution — for example, remove an external recipient, narrow a date range, or strip sensitive fields. Available through the `callback` method. Every edit preserves the original request in the audit log.

## Timeouts

Every approval request expires. On expiration Warden does not execute the call, returns a structured timeout to the agent, and writes an audit event. Long timeouts assume a background/async agent — a synchronous chat request usually can't hold the connection open, so keep those short or use `callback` with your own pending-state UI.

## Approval Policies

Policy can require specific approvers or a reason per tool:

```yaml
tools:
  openai.update_subscription_plan:
    decision: require_approval
    approval:
      timeout_seconds: 300
      approvers:
        - support-lead

  openai.merge_pull_request:
    decision: require_approval
    approval:
      approvers:
        - repo_owner
      require_reason: true   # needs the callback method
```

## Audit Requirements

Approval audit records include the original request, the redacted display request, the final executed request, the decision, approver identity, approval timestamp, policy version, any reason provided, and timeout/failure details. Edits remain diffable against the original.

## Safety Rules

- Deny by default if the approval channel is unavailable.
- Do not let the agent approve its own request.
- Do not allow prompt text to define approvers.
- Do not auto-approve based only on model confidence.
- Do not hide rejected calls from the audit log.
- Do not execute edited requests without recording the original request.

## Avoiding Approval Fatigue

Reserve approvals for meaningful risk: allow known read-only calls by default, give each tool one clear side effect with a specific name and schema, and add narrow tool-specific rules from repeated approvals once you see real audit data.
