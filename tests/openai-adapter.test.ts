import test from "node:test";
import assert from "node:assert/strict";
import { guardTool, guardTools } from "../src/adapters/openai.js";
import { callbackReviewer } from "../src/approval/methods.js";
import { defaultPolicyConfig } from "../src/policy/defaults.js";

test("guardTool runs an allowed tool and returns its output", async () => {
  const config = defaultPolicyConfig();
  let called = false;

  const guarded = guardTool(
    {
      name: "search_orders",
      description: "Search orders",
      execute: async (input: { query: string }) => {
        called = true;
        return `found ${input.query}`;
      },
    },
    { config },
  );

  const output = await guarded.execute({ query: "abc" });
  assert.equal(called, true);
  assert.equal(output, "found abc");
});

test("guardTool blocks denied actions without executing", async () => {
  const config = defaultPolicyConfig();
  config.defaults.destructive = "deny";
  let called = false;

  const guarded = guardTool(
    {
      name: "run_sql",
      description: "Run SQL",
      execute: async (_input: { sql: string }) => {
        called = true;
        return "ok";
      },
    },
    { config },
  );

  const output = await guarded.execute({ sql: "drop table users" });
  assert.equal(called, false);
  assert.match(String(output), /Warden blocked this action/i);
});

test("guardTool classifies JSON-schema parameters", async () => {
  const config = defaultPolicyConfig();
  config.defaults.unknown = "allow";
  let called = false;

  const guarded = guardTool(
    {
      name: "lookup",
      description: "Lookup a record",
      parameters: {
        type: "object",
        properties: {
          api_token: { type: "string" },
        },
      },
      execute: async (_input: Record<string, unknown>) => {
        called = true;
        return "ok";
      },
    },
    { config },
  );

  const output = await guarded.execute({});
  assert.equal(called, false);
  assert.match(String(output), /Warden blocked this action/i);
});

test("guardTool classifies Zod-like parameter shapes", async () => {
  const config = defaultPolicyConfig();
  config.defaults.unknown = "allow";
  config.defaults.external_send = "deny";
  let called = false;

  const guarded = guardTool(
    {
      name: "lookup",
      description: "Lookup a record",
      parameters: {
        shape: {
          recipient: {
            description: "External email address",
          },
        },
      },
      execute: async (_input: Record<string, unknown>) => {
        called = true;
        return "ok";
      },
    },
    { config },
  );

  const output = await guarded.execute({});
  assert.equal(called, false);
  assert.match(String(output), /Warden blocked this action/i);
});

test("guardTool namespaces bare tool names under openai", async () => {
  const config = defaultPolicyConfig();
  config.defaults.unknown = "deny";
  let blockedTool = "";

  const guarded = guardTool(
    {
      name: "mystery",
      execute: async (_input: Record<string, unknown>) => "x",
    },
    {
      config,
      onBlocked: (result) => {
        blockedTool = result.auditEvent.tool;
        return "blocked";
      },
    },
  );

  await guarded.execute({});
  assert.equal(blockedTool, "openai.mystery");
});

test("guardTool approves write actions through a callback reviewer", async () => {
  const config = defaultPolicyConfig();
  const guarded = guardTool(
    {
      name: "update_order",
      description: "Update an order",
      execute: async (_input: { id: number }) => "updated",
    },
    {
      config,
      reviewer: callbackReviewer(() => ({ decision: "approve", approver: "human" })),
    },
  );

  const output = await guarded.execute({ id: 1 });
  assert.equal(output, "updated");
});

test("guardTools wraps a whole array and honors a custom upstream", async () => {
  const config = defaultPolicyConfig();

  const [first, second] = guardTools(
    [
      { name: "a", description: "list things", execute: async (_i: Record<string, unknown>) => "A" },
      { name: "b", description: "get thing", execute: async (_i: Record<string, unknown>) => "B" },
    ],
    { config, upstream: "tools" },
  );

  assert.ok(first && second);
  assert.equal(await first.execute({}), "A");
  assert.equal(await second.execute({}), "B");
});
