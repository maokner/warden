# Warden

**A guardrail for OpenAI agents. It sits between your `@openai/agents` agent and the tools it can call.**

An agent with tools can query databases, send messages, edit files, hit APIs, and move money. Warden inspects every tool call your agent tries to make and decides — by policy — whether to **allow it, block it, or pause for a human** first. Every decision is written to an audit log.

![Warden action flow](docs/assets/warden-openai-flow.svg)

Warden wraps the tools you pass to the OpenAI Agents SDK. It classifies each tool call, applies your policy, asks for approval when needed, and records an audit event — without you rebuilding the agent.

## Why

Most teams connecting an agent to real systems can't answer simple questions: *What is this agent allowed to do? Which actions need approval? What exactly ran, and who signed off?* Warden is the boundary that answers them.

## How it works

1. **Classify.** Warden reads each tool call's name, description, schema, and arguments, then tags it with risk labels like `read`, `write`, `destructive`, `external_send`, `credential_access`, or `financial`.
2. **Decide.** Your policy maps each risk to a decision: `allow`, `deny`, `require_approval`, or `redact_then_allow`. Secure defaults ship out of the box — reads are allowed, writes and sends need approval, credential and financial actions are denied.
3. **Enforce.** Allowed calls run. Denied calls never reach the tool. Approval-required calls pause for a human and fail closed if nobody responds.
4. **Audit.** Every call produces a JSONL audit event — decision, risk labels, policy rule, arguments (with secrets redacted), result, and duration.

## Install

Requires Node.js 22+ and an `@openai/agents` app (or a brand-new project).

```bash
npm install @openai/agents zod @maokner/warden
```

Do not install the unscoped `warden` package from npm; that name belongs to an unrelated project. The library import path is `@maokner/warden` (and `@maokner/warden/openai`), and the CLI command is `warden`.

There are two ways to adopt Warden.

## Path 1 — Start a new agent from scratch

`warden init` scaffolds a runnable, already-guarded agent:

```bash
warden init                              # writes warden.yaml + agent.ts
warden login --token <telegram-bot-token>  # pair a phone to approve actions
export OPENAI_API_KEY=sk-...
npx tsx agent.ts
```

`agent.ts` is a complete OpenAI agent whose tools are wrapped with Warden. The example tool sends an email, which is classified as `external_send` and pauses for approval — so the first run shows you the whole flow. Edit `agent.ts` to add your own tools; coverage stays automatic.

## Path 2 — Add Warden to an existing agent

Generate just the policy, then wrap the tools you already pass to the SDK:

```bash
warden init --policy-only                # writes warden.yaml only
warden login --token <telegram-bot-token>
```

```ts
import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";
import { configureWarden } from "@maokner/warden";
import { guardTools } from "@maokner/warden/openai";

configureWarden(); // loads warden.yaml and Telegram credentials

const rawTools = [
  {
    name: "issue_refund",
    description: "Refund a payment",
    parameters: z.object({
      paymentId: z.string(),
      amount: z.number(),
      reason: z.string(),
    }),
    execute: async ({ paymentId, amount }) => stripe.refunds.create({ paymentId, amount }),
  },
];

const tools = guardTools(rawTools).map(tool);

const agent = new Agent({ name: "support", tools });

const result = await run(agent, "Refund payment pi_123 for 25 dollars.");
console.log(result.finalOutput);
```

That is the whole change: move your tool definitions into a raw array, wrap the **whole array** with `guardTools()`, then `.map(tool)`. Wrapping the array (not one tool at a time) is what keeps coverage complete as tools are added.

Risky calls pause and ask the approver. Reads run. Credential and financial-looking actions are denied by default. Every decision lands in `.warden/audit.jsonl`.

## Approvals

When a call needs approval, Warden stalls it until the timeout, then fails closed. How a human responds is the `approval.method`:

- **`telegram`** (default) — DMs the approver a poll (✅ Approve / ❌ Deny) with the redacted details; they tap a button on their phone. Link a device once with your own bot (created via @BotFather):
  ```bash
  warden login --token <bot-token>   # then tap the printed t.me link to pair
  ```
  The bot token and approver chat id are stored in `~/.warden/telegram.json` (never in `warden.yaml`). You bring your own bot — there is no Warden backend.
- **`callback`** — wire your own UI / Slack / on-call by passing a function:
  ```ts
  configureWarden({ approval: { onApproval: async (req) => ({ decision: "approve", approver: "you" }) } });
  ```
- **`deny`** — never approves; the action is refused with a clear message. Zero setup, fully fail-closed.

Long timeouts assume a background/async agent — a synchronous chat request usually can't hold the connection open, so keep those short or use `callback`.

## Configuration

A policy is a `warden.yaml` file. `warden init` generates a starter.

```yaml
defaults:            # decision per risk label
  read: allow
  write: require_approval
  destructive: require_approval
  external_send: require_approval
  credential_access: deny
  financial: deny

tools:               # override decisions for specific tools (namespaced "openai.<name>")
  openai.search_orders:
    decision: allow
  openai.send_invoice_email:
    decision: require_approval

redaction:           # fields scrubbed from approval messages + audit logs
  fields: [password, token, api_key, secret]

approval:            # how approval-required actions are handled
  method: telegram   # deny | callback | telegram
  timeout: 5m        # 0s | 30s | 1m | 5m | 30m | 1h

audit:
  path: .warden/audit.jsonl
```

A `deny` from a risk default always wins — a tool-specific rule can't weaken it.

## CLI

```
warden init [--path warden.yaml] [--agent agent.ts] [--policy-only] [--force]
            [--approval-method deny|callback|telegram] [--approval-timeout 5m]
warden policy test <call.json> [--config warden.yaml] [--json]   # preview a decision
warden audit tail [--limit 20] [--json]                          # read the audit log
warden login --token <bot-token>                                 # link a Telegram approver
```

Try a decision against the included example:

```bash
warden policy test examples/calls/stripe-refund.json --config examples/policies/warden.yaml
```

## What Warden does not do

Warden is a control boundary, not a prompt or a general sandbox. It protects tool calls that are routed through `guardTools`. If your app keeps another unguarded path to the same API, Warden cannot approve or audit that path. Read the [Security Model](docs/security-model.md) before relying on it for enforcement.

## Documentation

- [Documentation index](docs/README.md) — all guides and references
- [Quickstart: a new agent](docs/from-scratch.md) — scaffold a guarded agent from scratch (Path 1)
- [Quickstart: an existing agent](docs/openai-quickstart.md) — add Warden to an `@openai/agents` app (Path 2)
- [Migrating existing agents](docs/migrating-existing-agents.md) — wrap old tool arrays safely
- [How Warden works](docs/how-warden-works.md) — classifier, policy, approval, audit
- [Security Model](docs/security-model.md) — what Warden can and cannot guarantee

## Development

```bash
pnpm install
pnpm test        # build + run the test suite
pnpm typecheck
```
