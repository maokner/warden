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

test("telegram method without credentials fails closed", async () => {
  const savedToken = process.env["WARDEN_TELEGRAM_TOKEN"];
  const savedChat = process.env["WARDEN_TELEGRAM_CHAT_ID"];
  delete process.env["WARDEN_TELEGRAM_TOKEN"];
  delete process.env["WARDEN_TELEGRAM_CHAT_ID"];

  try {
    configureWarden({
      config: defaultPolicyConfig(),
      approval: {
        method: "telegram",
        // Point at a path that does not exist so no machine credentials leak in.
        credentialsPath: "/nonexistent/warden-telegram-test.json",
      },
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
  } finally {
    if (savedToken !== undefined) {
      process.env["WARDEN_TELEGRAM_TOKEN"] = savedToken;
    }
    if (savedChat !== undefined) {
      process.env["WARDEN_TELEGRAM_CHAT_ID"] = savedChat;
    }
  }
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
