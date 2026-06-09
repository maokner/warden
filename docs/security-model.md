# Security Model

Warden is an action-control boundary for OpenAI agents built with `@openai/agents`.

It is meant for agents you build into products, internal tools, support workflows, operations dashboards, and backend apps — an application agent that can call tools with real side effects.

![Warden OpenAI flow](assets/warden-openai-flow.svg)

## Core Claim

Warden can control a tool call when that call is routed through Warden before it reaches the real executor:

- `guardTools()` wraps OpenAI Agents SDK function tools before `execute` runs.

Warden cannot control a second path that bypasses it. If your app still calls Stripe, Slack, SendGrid, a database, or an internal API directly from another unguarded path, Warden cannot approve or audit that path.

## Threat Model For App-Built Agents

Assume an agent may:

- choose the wrong tool for the user's request
- overfill tool arguments
- send messages to the wrong recipient
- update the wrong record
- call a tool based on stale or incomplete context
- expose sensitive arguments in logs or responses
- trigger a third-party API call that cannot be undone
- repeat an action after a retry or model loop

Warden treats the model's requested action as untrusted until policy allows it or a human approves it.

## What Warden Controls

### Tool Execution

The guarded executor is the only place where a model-requested action can become a side effect.

```text
model-selected tool call -> Warden decision -> original execute function
```

Denied and expired approvals never reach the original function.

### Approval

Risky calls can pause for a human. The scaffold defaults to the terminal `prompt` method, which needs no account, bot, or backend — ideal for local development. It fails closed when no interactive terminal is attached, so a background or production agent should use `telegram` (a phone poll, no Warden-hosted backend) or `callback` (your own approval UI). All channels fail closed when the approval channel is unavailable.

Approval records include redacted arguments. The original arguments are preserved for execution and audit handling.

### Audit

Every decision creates an audit event with:

- tool name
- risk labels
- policy version
- decision
- policy rule
- redacted request arguments
- execution status
- error or response summary

The local audit log is useful for development and early deployment. For team production use, stream audit events to an append-only remote store.

### Redaction

Warden redacts configured fields and secret-looking substrings from approval displays and audit logs.

Redaction reduces accidental exposure. It is not a substitute for keeping raw secrets out of agent-accessible arguments.

## Main Bypass Paths

### Unguarded Functions

If the app keeps both guarded and unguarded versions of a side-effect function, the unguarded one can still run.

Control:

- route side effects through the agent's guarded tools (`guardTools`)
- search for direct calls during migration
- keep risky functions in one module and export only the guarded version

### Direct API Clients

If other app code calls protected APIs directly, Warden will not see those actions.

Control:

- wrap service clients with guarded functions
- put high-risk API calls behind a small service layer
- add tests that import the guarded service instead of raw SDK clients

### Hosted Tools

OpenAI-hosted tools (web search, computer use, server-side MCP tools) execute on OpenAI's infrastructure. There is no local `execute`/`invoke` for Warden to wrap, so `guardTools` passes them through unguarded and prints a warning rather than crashing the agent.

Control:

- treat every hosted tool in the array as outside the boundary
- prefer local function tools for side effects you need policy over
- watch for the pass-through warning in logs when tool arrays change

### Overbroad Tools

A tool named `execute_action` with a free-form payload is hard to classify and hard to approve safely.

Control:

- split read and write tools
- give each tool one clear side effect
- use descriptive names, descriptions, and schemas
- avoid arbitrary "method" or "operation" arguments for risky tools

### Missing Identity

If the app does not pass user, tenant, or run context, audits are less useful.

Control:

- pass `user`, `agent`, `runId`, and `callId` where possible
- keep tenant and actor ids in arguments or metadata when safe
- add policy rules per tool before relying on broad defaults

### Local Audit Tampering

Local JSONL logs are easy to inspect but not tamper resistant.

Control:

- use local audit during development
- write audit logs outside writable app workspaces when possible
- forward audit events to central storage for production

## Recommended Production Shape

For a production app-built agent:

1. Keep Warden policy in source control or managed config.
2. Initialize Warden once at app startup.
3. Build agents from guarded tool arrays only.
4. Route high-risk service calls through guarded functions.
5. Use the terminal `prompt` method for local development, then switch to `telegram` or `callback` for any unattended deployment — `prompt` fails closed without a TTY, so it cannot approve anything in a background or production process.
6. Store audit events centrally if approvals affect customers, money, permissions, or external communications.

## What Warden Is Not

Warden is not a prompt-level safety instruction. The model does not get to decide whether policy applies.

Warden is not a general application firewall. It only controls calls that are routed through it.

Warden is not a complete production governance platform yet. The current package is local-first and developer-friendly; production teams should add central audit storage, managed policy ownership, and deployment checks around it.
