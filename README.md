# Warden

**A local control layer that sits between an AI agent and the tools it can call.**

Agents can now query databases, send messages, edit files, hit APIs, and move money. Warden inspects every action an agent tries to take and decides — by policy — whether to **allow it, block it, or pause for a human** first. Every decision is written to an audit log.

```
agent ──▶ warden ──▶ tool / API / database
            │
            ├─ classify the action's risk
            ├─ apply your policy (allow / deny / require approval)
            ├─ redact secrets from logs
            └─ record an audit event
```

## Why

Most teams connecting an agent to real systems can't answer simple questions: *What is this agent allowed to do? Which actions need approval? What exactly ran, and who signed off?* Warden is the boundary that answers them, without rebuilding your agent.

## How it works

1. **Classify.** Warden reads each tool call's name, description, schema, arguments, and any SQL, then tags it with risk labels like `read`, `write`, `destructive`, `external_send`, `credential_access`, or `financial`.
2. **Decide.** Your policy maps each risk to a decision: `allow`, `deny`, `require_approval`, or `redact_then_allow`. Secure defaults ship out of the box — reads are allowed, writes and sends need approval, credential and financial actions are denied.
3. **Enforce.** Allowed calls run. Denied calls never reach the tool. Approval-required calls pause for a human and fail closed if nobody responds.
4. **Audit.** Every call produces a JSONL audit event — decision, risk labels, policy rule, arguments (with secrets redacted), result, and duration.

## Install

Requires Node.js 22+.

```bash
pnpm install
pnpm run build
```

The examples below call `warden`. From a local clone that's `node dist/src/cli/index.js` — run `npm link` to put `warden` on your `PATH`.

## Use it

Warden offers a few ways to put a boundary in front of your tools. Pick whichever fits your stack.

### 1. Around your OpenAI Agents SDK tools

`guardTools` wraps your tool definitions so every call is classified, policy-checked, audited, and (if required) approved — one line, no other changes. A blocked call comes back to the model as a readable message instead of running.

```ts
import { tool } from "@openai/agents";
import { configureWarden } from "warden";
import { guardTools } from "warden/openai";

configureWarden(); // secure defaults; loads warden.yaml if present

const tools = guardTools([
  {
    name: "issue_refund",
    description: "Refund a payment",
    parameters: refundSchema,
    execute: async ({ paymentId, amount }) => stripe.refunds.create({ paymentId, amount }),
  },
]).map(tool);

const agent = new Agent({ name: "support", tools });
```

Wrap the whole array, not one tool at a time — that's how coverage stays complete.

### 2. Any function, anywhere

`guard` wraps a single function and returns one with the same signature; it throws if the call is blocked.

```ts
import { configureWarden, guard } from "warden";

configureWarden();

const runSql = guard("database.run_sql", (args) => db.query(String(args.sql)), {
  description: "Run SQL against the production database",
});

await runSql({ sql: "drop table users" }); // throws: destructive SQL is denied before db.query runs
```

### 3. As an MCP gateway

Add upstream MCP servers to `warden.yaml`, then run Warden as a single MCP server your agent connects to. Warden namespaces and policies every upstream tool, and prompts for risky calls on the terminal.

```bash
warden proxy --config warden.yaml
```

Generate the client config snippet:

```bash
warden setup claude --config warden.yaml   # or: warden setup codex
```

### 4. As a local HTTP sidecar

For non-TypeScript or non-MCP stacks, ask Warden for a decision over localhost:

```bash
warden serve --config warden.yaml --port 8787

curl -s http://127.0.0.1:8787/v1/decide \
  -H 'Content-Type: application/json' \
  -d '{"tool":"database.run_sql","arguments":{"sql":"select id from users limit 1"}}'
```

The response includes the decision, risk classification, an audit event, and `forwardArguments` when your app may execute the action itself.

## Configuration

A policy is a `warden.yaml` file. Generate a starter with `warden init`.

```yaml
defaults:            # decision per risk label
  read: allow
  write: require_approval
  destructive: require_approval
  credential_access: deny
  financial: deny

tools:               # override decisions for specific tools
  filesystem.read_file:
    decision: allow
  filesystem.delete_file:
    decision: deny

redaction:           # fields scrubbed from audit logs
  fields: [password, token, api_key, secret]

approval:            # how approval-required actions are handled
  method: local      # deny | local | callback
  timeout: 1m        # none | 30s | 1m | 5m | 30m | 1h

audit:
  path: .warden/audit.jsonl
```

A `deny` from a risk default always wins — a tool-specific rule can't weaken it.

## Approvals

When a call needs approval, Warden stalls it until the timeout, then fails closed. How a human responds is the `approval.method`:

- **`deny`** — never approves; the action is refused with a clear message. Zero setup, fully fail-closed.
- **`local`** — opens a localhost approval inbox (a web page and a JSON API) in your app's process. Approve from the browser, or from the CLI:
  ```bash
  warden approvals          # list what's waiting
  warden approve <id>       # or: warden deny <id>
  ```
- **`telegram`** — DMs the approver a poll (✅ Approve / ❌ Deny) with the redacted details; they tap a button on their phone. Link a device once with your own bot (created via @BotFather):
  ```bash
  warden login --token <bot-token>   # then tap the printed t.me link to pair
  ```
  The bot token and approver chat id are stored in `~/.warden/telegram.json` (never in `warden.yaml`).
- **`callback`** — you wire your own UI/Slack/on-call by passing a function:
  ```ts
  configureWarden({ approval: { onApproval: async (req) => ({ decision: "approve", approver: "you" }) } });
  ```

Long timeouts assume a background/async agent — a synchronous chat request usually can't hold the connection open, so keep those short or use `callback`.

## CLI

```
warden init [--path warden.yaml] [--template default|database]
            [--approval-method deny|local|callback] [--approval-timeout 1m]
warden policy test <call.json> [--config warden.yaml] [--json]
warden inspect --config warden.yaml          # list upstream tools + their decisions
warden proxy --config warden.yaml            # run the MCP gateway
warden serve --config warden.yaml            # run the HTTP decision sidecar
warden approvals [--json]                    # list pending approvals (local method)
warden approve <id> / warden deny <id>       # resolve a pending approval
warden login --token <bot-token>             # link a Telegram approver device
warden audit tail [--limit 20] [--json]      # read the audit log
warden doctor [--config warden.yaml]         # check for ways an agent could bypass Warden
warden exec --config warden.yaml -- <cmd>    # launch a process with credentials scrubbed
```

Try it against the included examples:

```bash
warden policy test examples/calls/stripe-refund.json --config examples/policies/warden.yaml
```

## What Warden does not do

Warden is a control boundary, not a sandbox. It can only protect a tool when the agent can't also reach that tool directly — with the same credentials, environment variables, network, or shell. `warden doctor` flags those bypass paths, but read the [Security Model](docs/security-model.md) before relying on it for enforcement.

## Documentation

- [Security Model](docs/security-model.md) — what Warden can and cannot guarantee
- [Approval Workflow](docs/approval-workflow.md) — how human approval works
- [MCP Gateway](docs/mcp-gateway.md) — supported MCP surface and upstream config

## Development

```bash
pnpm test        # build + run the test suite
pnpm typecheck
```
