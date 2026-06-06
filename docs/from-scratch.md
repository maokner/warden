# Quickstart: A New Agent From Scratch

This guide stands up a brand-new OpenAI agent that is guarded by Warden from the first line of code. If you already have an `@openai/agents` app, use the [existing-agent quickstart](openai-quickstart.md) instead.

![Warden OpenAI flow](assets/warden-openai-flow.svg)

## 1. Scaffold

In an empty directory:

```bash
npm install @openai/agents zod @maokner/warden
warden init
```

`warden init` writes two files:

- `warden.yaml` — your policy (secure defaults; Telegram approval).
- `agent.ts` — a complete, runnable agent whose tools are already wrapped with Warden.

Use `warden init --policy-only` if you only want the policy file.

## 2. Pair an Approver

```bash
warden login --token <telegram-bot-token>
```

Create the bot with @BotFather first. `warden login` prints a `t.me` link; open it on the phone that should approve actions and tap **Start**. The bot token and approver chat id are stored in `~/.warden/telegram.json` with `0600` permissions — never in `warden.yaml`.

Prefer to wire your own verification instead of Telegram? Set `approval.method: callback` in `warden.yaml` and pass an `onApproval` function to `configureWarden()`. Set `approval.method: deny` to fail closed with zero setup.

## 3. Run It

```bash
export OPENAI_API_KEY=sk-...
npx tsx agent.ts
```

The scaffolded agent has one tool, `send_discount_email`. Sending an email is classified as `external_send`, which requires approval — so the first run pauses and DMs your approver. Approve it and the original `execute` runs; deny it (or let it time out) and the tool never runs.

## 4. What the Scaffold Looks Like

```ts
import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";
import { configureWarden } from "@maokner/warden";
import { guardTools } from "@maokner/warden/openai";

configureWarden(); // loads warden.yaml + Telegram credentials

const rawTools = [
  {
    name: "send_discount_email",
    description: "Send a discount email to a customer",
    parameters: z.object({
      customerEmail: z.string(),
      discountCode: z.string(),
    }),
    execute: async ({ customerEmail, discountCode }) =>
      emailClient.send({ to: customerEmail, template: "discount", discountCode }),
  },
];

const tools = guardTools(rawTools).map(tool);

const agent = new Agent({ name: "Support agent", tools });
const result = await run(agent, "Send Taylor a discount code.");
console.log(result.finalOutput);
```

See the full file: [`examples/openai-from-scratch.ts`](../examples/openai-from-scratch.ts).

## 5. Add Your Own Tools

Add objects to `rawTools` and keep wrapping the **whole array** with `guardTools()`. That is what keeps coverage automatic as the agent grows — you never have to remember to guard a new tool individually.

Give each tool a specific name, description, and schema. Warden classifies from those signals, so `send_invoice_email` is graded far more precisely than `do_task`.

## 6. Inspect the Audit Log

```bash
warden audit tail --limit 20
```

Each entry includes the tool, risk labels, decision, policy rule, redacted arguments, status, and duration.

## 7. Tune Policy Later

Start strict, then add tool-specific rules once you see real audit data. Tool names are namespaced `openai.<your_tool_name>`:

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
