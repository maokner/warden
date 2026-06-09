# OpenAI Agents SDK Quickstart

This guide is for a developer who already has a working `@openai/agents` app with tools. The goal is to add Warden without changing the agent loop or rewriting the tool logic.

![Warden OpenAI flow](assets/warden-openai-flow.svg)

## What You Get

- Read-only tool calls can run.
- Risky tool calls pause and ask a human — in your terminal by default, or on your phone via Telegram.
- Credential and financial-looking calls are denied by default.
- Every decision is written to `.warden/audit.jsonl`.
- The model gets a plain blocked-action message instead of the side effect running.

## 1. Install

```bash
npm install @openai/agents zod @maokner/warden
warden init --policy-only
```

Do not install the unscoped `warden` package from npm; that package name belongs to an unrelated project. The library import path is `@maokner/warden` (and `@maokner/warden/openai`), and the CLI command is `warden`.

`warden init --policy-only` writes just `warden.yaml` (no scaffolded `agent.ts`), which is what you want when you already have an agent. Approvals default to the `prompt` method, which asks you right in the terminal — no bot, account, or backend to set up. (Want phone approval instead? See [step 4](#4-approve-from-your-phone-optional).)

## 2. Guard the Tools You Already Have

If your agent already builds tools with `tool(...)`, you do not have to refactor anything. `guardTools()` accepts the `FunctionTool` objects `tool()` returns, so adoption is a one-line change — wrap the array you already pass to the agent:

```ts
import { Agent, run } from "@openai/agents";
import { configureWarden } from "@maokner/warden";
import { guardTools } from "@maokner/warden/openai";

configureWarden();

// `existingTools` is your current array of tool(...) results — unchanged.
const agent = new Agent({ name: "support", tools: guardTools(existingTools) });
const result = await run(agent, "Send Taylor a discount code.");
console.log(result.finalOutput);
```

That is the whole change. `guardTools()` wraps each tool's executor so it is classified, policy-checked, approved when needed, and audited — your tool code, schemas, prompts, and `run(...)` call stay the same.

Hosted tools (such as `webSearchTool()`) execute on OpenAI's servers, so there is no local function for Warden to intercept; `guardTools` passes them through unguarded and prints a warning so you know they are outside the boundary.

### Alternative: wrap raw definitions before `tool()`

If you'd rather define tools as plain objects (handy for brand-new code), keep the definitions in an array, wrap it, then `.map(tool)`:

```ts
import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";
import { configureWarden } from "@maokner/warden";
import { guardTools } from "@maokner/warden/openai";

configureWarden();

const rawTools = [
  {
    name: "send_discount_email",
    description: "Send a discount email to a customer",
    parameters: z.object({
      customerEmail: z.string(),
      discountCode: z.string(),
    }),
    execute: async ({ customerEmail, discountCode }) => {
      return emailClient.send({ to: customerEmail, template: "discount", discountCode });
    },
  },
];

const tools = guardTools(rawTools).map(tool);

const agent = new Agent({ name: "support", tools });
const result = await run(agent, "Send Taylor a discount code.");
console.log(result.finalOutput);
```

Raw definitions, already-constructed tools, or a mix all work — wrap the **whole array** either way so coverage stays automatic as you add tools.

See the full example pair:

- [Before Warden](../examples/openai-existing-agent-before.ts)
- [With Warden](../examples/openai-existing-agent-with-warden.ts)

## 3. Run A Risky Action

When the agent calls `send_discount_email`, Warden sees `send`, `email`, and the email-like schema/argument values. The default OpenAI template marks this as `external_send`, which requires approval.

With the default `prompt` method, Warden pauses and asks you in the terminal (`Approve this action? [y/N]`) with redacted action details. Approve before the timeout and the original `execute` function runs; deny or let it expire and the tool never runs.

## 4. Approve From Your Phone (optional)

The terminal prompt fails closed when there is no interactive terminal, so a background or production agent should use a remote channel. Pair a Telegram bot once and switch one line of `warden.yaml`:

```bash
warden login --token <telegram-bot-token>   # then set approval.method: telegram
```

Create the bot with BotFather first. `warden login` prints a `t.me` link; open it on the phone that should approve actions, then tap Start. The bot token and approver chat id are stored in `~/.warden/telegram.json` with `0600` permissions — the token never lives in `warden.yaml`. Prefer your own approval UI? Set `approval.method: callback` and pass `onApproval` to `configureWarden()`.

## 5. Inspect The Audit

```bash
warden audit tail --limit 20
```

Audit entries include the tool name, risk labels, policy decision, policy rule, redacted request arguments, execution status, and duration.

## 6. Tune Policy Later

Start strict, then add tool-specific rules once you see real audit data.

```yaml
tools:
  openai.search_orders:
    decision: allow
  openai.send_discount_email:
    decision: require_approval
    approval:
      timeout_seconds: 300
      approvers:
        - alice
  openai.issue_refund:
    acknowledge_risks: [financial]   # accept the default financial deny for this tool
    decision: require_approval
    rules:                           # argument conditions, first match wins
      - when:
          amount: { lte: 50 }
        decision: allow
      - when:
          amount: { gt: 500 }
        decision: deny
```

Tools that look financial or credential-shaped are denied outright by default; `acknowledge_risks` is the explicit opt-out and floors them at `require_approval`. Argument `rules` then carve out the routine cases (small refunds run unprompted) and the extreme ones (large refunds never execute).

Do not add broad `allow` rules for tools that send messages, write records, or call third-party APIs until you know the exact side effect and arguments are safe.

## Common First-Run Problems

### Everything Is Denied In A Background Or CI Run

The default `prompt` method needs an interactive terminal to ask in. With no TTY (a daemon, container, or CI job) it fails closed and denies every approval-required call. Switch to a remote channel for unattended agents: set `approval.method: telegram` (after `warden login`) or `approval.method: callback`.

### Telegram Is Not Configured

If `approval.method: telegram` is enabled but no Telegram credentials are available, Warden fails closed. Run:

```bash
warden login --token <telegram-bot-token>
```

You can also set `WARDEN_TELEGRAM_TOKEN` and `WARDEN_TELEGRAM_CHAT_ID`.

### The Tool Still Runs Without Warden

Make sure the agent receives only wrapped tools:

```ts
const agent = new Agent({ name: "support", tools: guardTools(existingTools) });
```

Do not keep a second unguarded `tools` array in the agent config.

### Everything Requires Approval

That usually means tool names/descriptions/schemas are too vague. Give tools specific names and descriptions:

- Good: `search_orders`, `send_invoice_email`, `update_subscription`
- Bad: `do_task`, `run`, `execute`

Warden classifies from the tool name, description, parameter schema, arguments, and SQL-looking strings.
