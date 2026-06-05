# Generic Action Boundary

Warden's core product is an action boundary for agents.

MCP is one useful adapter, but the same policy engine can guard any backend function that an agent can call: SQL queries, internal APIs, email senders, billing actions, admin tools, or deployment operations.

## Website Chatbot Database Example

A website chatbot might have a tool like this:

```ts
async function runSql(sql: string) {
  return db.query(sql);
}
```

That direct call gives the agent the same database power as the app. A bad prompt, tool-use bug, or compromised conversation could ask for:

```sql
drop table users;
```

Put Warden between the agent and the database:

```ts
import { defaultPolicyConfig, guardAction } from "warden";

const policy = defaultPolicyConfig();
policy.defaults.destructive = "deny";

export async function guardedRunSql(sql: string, userId: string) {
  const result = await guardAction({
    config: policy,
    tool: "database.run_sql",
    description: "Run SQL against the production application database",
    arguments: { sql },
    client: "website_chatbot",
    agent: "support_agent",
    user: userId,
    execute: async (args) => {
      return db.query(String(args.sql));
    },
  });

  if (!result.executed) {
    throw new Error(result.error ?? "Database action blocked by Warden.");
  }

  return result.output;
}
```

With that policy:

- `select id, email from users limit 10` is classified as `read` and allowed.
- `update users set plan = 'pro' where id = 1` requires approval and fails closed if no reviewer is configured.
- `drop table users` is classified as `write, destructive` and denied before the database function runs.

## What Gets Logged

When an audit path is configured, Warden records:

- user, agent, client, and tool identity
- original arguments
- risk labels and policy decision
- whether execution happened
- final executed arguments, if any
- response status and summary
- errors from the underlying function

## Design Rule

The agent should never call protected systems directly.

Instead:

```text
agent -> app tool wrapper -> Warden guard -> protected database/API
```

If the agent can bypass the guard and reach the database directly with the same credentials, Warden can only monitor; it cannot enforce.
