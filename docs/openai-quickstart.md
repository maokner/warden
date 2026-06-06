# OpenAI Agents SDK Quickstart

This guide is for a developer who already has a working `@openai/agents` app with tools. The goal is to add Warden without changing the agent loop or rewriting the tool logic.

![Warden OpenAI flow](assets/warden-openai-flow.svg)

## What You Get

- Read-only tool calls can run.
- Risky tool calls pause and DM the linked Telegram approver.
- Credential and financial-looking calls are denied by default.
- Every decision is written to `.warden/audit.jsonl`.
- The model gets a plain blocked-action message instead of the side effect running.

## 1. Install And Pair Telegram

```bash
npm install @openai/agents zod @maokner/warden
warden init --policy-only
warden login --token <telegram-bot-token>
```

Do not install the unscoped `warden` package from npm; that package name belongs to an unrelated project. The library import path is `@maokner/warden` (and `@maokner/warden/openai`), and the CLI command is `warden`.

`warden init --policy-only` writes just `warden.yaml` (no scaffolded `agent.ts`), which is what you want when you already have an agent.

Create the bot with BotFather first. `warden login` prints a `t.me` link. Open it on the phone that should approve actions, then tap Start. Prefer your own approval UI? Set `approval.method: callback` and pass `onApproval` to `configureWarden()`.

The login command stores the bot token and approver chat id in `~/.warden/telegram.json` with `0600` permissions. The bot token does not need to live in `warden.yaml`.

## 2. Wrap Existing OpenAI Tool Definitions

Before:

```ts
import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";

const tools = [
  tool({
    name: "send_discount_email",
    description: "Send a discount email to a customer",
    parameters: z.object({
      customerEmail: z.string(),
      discountCode: z.string(),
    }),
    execute: async ({ customerEmail, discountCode }) => {
      return emailClient.send({ to: customerEmail, template: "discount", discountCode });
    },
  }),
];

const agent = new Agent({ name: "support", tools });
const result = await run(agent, "Send Taylor a discount code.");
console.log(result.finalOutput);
```

After:

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

That is the main migration: keep the tool object shape, wrap the array, then call `.map(tool)`.

See the full example pair:

- [Before Warden](../examples/openai-existing-agent-before.ts)
- [With Warden](../examples/openai-existing-agent-with-warden.ts)

## 3. Run A Risky Action

When the agent calls `send_discount_email`, Warden sees `send`, `email`, and the email-like schema/argument values. The default OpenAI template marks this as `external_send`, which requires approval.

The approver receives a Telegram poll with redacted action details. If they approve before timeout, the original `execute` function runs. If they deny or the request expires, the tool never runs.

## 4. Inspect The Audit

```bash
warden audit tail --limit 20
```

Audit entries include the tool name, risk labels, policy decision, policy rule, redacted request arguments, execution status, and duration.

## 5. Tune Policy Later

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
```

Do not add broad `allow` rules for tools that send messages, write records, or call third-party APIs until you know the exact side effect and arguments are safe.

## Common First-Run Problems

### Telegram Is Not Configured

If `approval.method: telegram` is enabled but no Telegram credentials are available, Warden fails closed. Run:

```bash
warden login --token <telegram-bot-token>
```

You can also set `WARDEN_TELEGRAM_TOKEN` and `WARDEN_TELEGRAM_CHAT_ID`.

### The Tool Still Runs Without Warden

Make sure the agent receives only wrapped tools:

```ts
const tools = guardTools(rawTools).map(tool);
```

Do not keep a second unguarded `tools` array in the agent config.

### Everything Requires Approval

That usually means tool names/descriptions/schemas are too vague. Give tools specific names and descriptions:

- Good: `search_orders`, `send_invoice_email`, `update_subscription`
- Bad: `do_task`, `run`, `execute`

Warden classifies from the tool name, description, parameter schema, arguments, and SQL-looking strings.
