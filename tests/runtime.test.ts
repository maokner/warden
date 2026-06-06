import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  configureWarden,
  getWardenRuntime,
  resetWarden,
} from "../src/sdk/runtime.js";
import { guardAction } from "../src/sdk/guard.js";
import { defaultPolicyConfig } from "../src/policy/defaults.js";

afterEach(() => resetWarden());

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("deny method blocks approval-required calls", async () => {
  configureWarden({
    config: defaultPolicyConfig(),
    approval: { method: "deny" },
    auditPath: false,
  });

  let executed = false;
  const result = await guardAction({
    tool: "db.update_row",
    description: "Update a row",
    arguments: { id: 1 },
    execute: async () => {
      executed = true;
      return "ok";
    },
  });

  assert.equal(executed, false);
  assert.equal(result.executed, false);
  assert.match(result.error ?? "", /rejected|approval/i);
});

test("callback method approves through the configured callback", async () => {
  configureWarden({
    config: defaultPolicyConfig(),
    approval: { onApproval: () => ({ decision: "approve", approver: "human" }) },
    auditPath: false,
  });

  const result = await guardAction({
    tool: "db.update_row",
    description: "Update a row",
    arguments: { id: 1 },
    execute: async () => ({ updated: true }),
  });

  assert.equal(result.executed, true);
  assert.equal(result.approval?.status, "approved");
  assert.equal(result.approval?.approver, "human");
});

test("local method parks approval-required calls in the queue", async () => {
  const runtime = configureWarden({
    config: defaultPolicyConfig(),
    approval: { method: "local", port: 0 },
    auditPath: false,
  });

  assert.ok(runtime.server);
  assert.ok(runtime.queue);

  const pending = guardAction({
    tool: "db.update_row",
    description: "Update a row",
    arguments: { id: 1 },
    execute: async () => "ok",
  });

  await tick();
  const queue = runtime.queue;
  assert.ok(queue);
  assert.equal(queue.list().length, 1);

  const id = queue.list()[0]?.id as string;
  assert.equal(queue.approve(id, { approver: "alice" }), true);

  const result = await pending;
  assert.equal(result.executed, true);
  assert.equal(result.approval?.approver, "alice");
});

test("getWardenRuntime returns the active runtime; resetWarden clears it", () => {
  const runtime = configureWarden({
    config: defaultPolicyConfig(),
    auditPath: false,
  });
  assert.equal(getWardenRuntime(), runtime);

  resetWarden();
  assert.notEqual(getWardenRuntime(), runtime);
});
