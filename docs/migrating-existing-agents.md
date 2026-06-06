# Migrating Existing Agents

Use this guide when your OpenAI Agents SDK app already works and you want Warden to guard the actions without changing the agent's behavior.

![Warden migration map](assets/warden-migration-map.svg)

## Migration Principle

Do not rewrite the agent first. Move the tool definitions into a raw array, wrap that array with Warden, and keep your existing `execute` functions.

The smallest safe migration is:

```ts
configureWarden();
const tools = guardTools(rawTools).map(tool);
```

Full examples:

- [Before Warden](../examples/openai-existing-agent-before.ts)
- [With Warden](../examples/openai-existing-agent-with-warden.ts)

## Step 1. Inventory Existing Tools

List every tool the agent can call and put it in one of these buckets:

| Bucket | Examples | Default Warden behavior |
| --- | --- | --- |
| Read-only lookup | search orders, get customer, list docs | allow |
| App mutation | update ticket, create record, change plan | require approval |
| External send | email, Slack, webhook, publish comment | require approval |
| Code or network execution | shell, HTTP fetch, browser automation | require approval |
| Credentials or secrets | token lookup, OAuth export, env read | deny |
| Financial | charge, refund, payout, invoice payment | deny |

If a tool can both read and mutate, split it into two tools before migration. Warden is much easier to reason about when tools have one clear side effect.

## Step 2. Move From Wrapped OpenAI Tools To Raw Tool Definitions

Many apps start like this:

```ts
const tools = [
  tool({
    name: "update_ticket",
    description: "Update a support ticket",
    parameters: updateTicketSchema,
    execute: updateTicket,
  }),
];
```

Change it to:

```ts
const rawTools = [
  {
    name: "update_ticket",
    description: "Update a support ticket",
    parameters: updateTicketSchema,
    execute: updateTicket,
  },
];

const tools = guardTools(rawTools).map(tool);
```

That keeps the OpenAI Agents SDK shape while giving Warden a chance to classify and enforce before `execute` runs.

## Step 3. Configure Warden Once

Call `configureWarden()` once at app startup, before constructing agents.

```ts
import { configureWarden } from "@maokner/warden";

configureWarden({
  configPath: "warden.yaml",
});
```

For most apps, do not pass policy inline. Keep it in `warden.yaml` so operators can inspect and review it separately from code changes.

## Step 4. Generate The Starter Policy

```bash
warden init --policy-only
warden login --token <telegram-bot-token>
```

The generated policy is intentionally conservative:

- `read: allow`
- `write`, `external_send`, `network_egress`, `code_execution`: `require_approval`
- `credential_access`, `financial`: `deny`
- `approval.method: telegram`

This is the right starting point for old codebases because it prevents silent side effects while you learn what the agent actually does.

## Step 5. Keep Tool Metadata Specific

Warden's classifier uses deterministic signals. Better metadata improves the decision before you write custom policy.

Use names like:

```text
search_customer_orders
send_refund_confirmation_email
update_subscription_plan
create_billing_note
```

Avoid names like:

```text
execute
run_action
tool
helper
```

Descriptions should say the side effect plainly:

```ts
description: "Send a refund confirmation email to a customer"
```

Schemas should use specific field names:

```ts
parameters: z.object({
  customerEmail: z.string(),
  refundAmountUsd: z.number(),
  internalNote: z.string(),
})
```

## Step 6. Decide How Blocks Surface To The Model

By default, a blocked OpenAI tool returns a short model-visible string:

```text
Warden blocked this action (require_approval). Approval expired.
```

If your agent needs a custom shape, pass `onBlocked`:

```ts
const tools = guardTools(rawTools, {
  onBlocked: (result) => ({
    status: "blocked_by_policy",
    reason: result.error ?? result.decision.reason,
    decision: result.decision.decision,
  }),
}).map(tool);
```

Do not hide policy failures from the model. The model needs to know the action did not run.

## Step 7. Add Narrow Policy Overrides

After you collect audit events, add targeted rules:

```yaml
tools:
  openai.search_customer_orders:
    decision: allow

  openai.update_subscription_plan:
    decision: require_approval
    approval:
      approvers:
        - support-lead
```

A tool-specific `allow` cannot override a default `deny` for credential or financial risks. That is deliberate.

## Step 8. Remove Unguarded Paths

Search the codebase for direct uses of the old tool array:

```bash
rg "tools:|tool\\(|execute:" src
```

Then confirm the agent is built from the guarded array only:

```ts
const agent = new Agent({ name: "support", tools });
```

If a side effect lives outside the agent's tool array, expose it to the agent as a tool and wrap it with `guardTools` too. Warden guards what the agent calls through guarded tools; a side effect the app triggers on its own path is not covered (see the [Security Model](security-model.md)).

## Migration Checklist

- `warden.yaml` exists and uses `approval.method: telegram`.
- `warden login` has paired the approver device.
- `configureWarden()` runs before agent construction.
- Existing tool definitions live in `rawTools`.
- The OpenAI agent receives `guardTools(rawTools).map(tool)`.
- No unguarded tool array is still passed to an agent.
- Risky tools produce Telegram approval requests.
- Audit events appear in `.warden/audit.jsonl`.
