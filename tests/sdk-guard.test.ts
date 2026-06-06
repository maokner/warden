import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import type { ApprovalReviewer } from "../src/approval/approval.js";
import { readAuditEvents } from "../src/audit/logger.js";
import { defaultPolicyConfig } from "../src/policy/defaults.js";
import { guardAction } from "../src/sdk/guard.js";

test("guardAction allows read-only SQL and executes the database function", async () => {
  const config = defaultPolicyConfig();
  let executedSql = "";

  const result = await guardAction({
    config,
    tool: "database.run_sql",
    description: "Run SQL against the application database",
    arguments: { sql: "select id, enabled from feature_flags limit 1" },
    execute: async (args) => {
      executedSql = String(args["sql"]);
      return { rows: [{ id: 1, enabled: true }] };
    },
    client: "website_chatbot",
    agent: "support_agent",
    user: "user_123",
  });

  assert.equal(result.executed, true);
  assert.equal(result.decision.decision, "allow");
  assert.equal(executedSql, "select id, enabled from feature_flags limit 1");
  assert.deepEqual(result.output, {
    rows: [{ id: 1, enabled: true }],
  });
  assert.equal(result.auditEvent.client, "website_chatbot");
  assert.equal(result.auditEvent.agent, "support_agent");
  assert.equal(result.auditEvent.user, "user_123");
});

test("guardAction fails closed for SQL writes when no reviewer is configured", async () => {
  const config = defaultPolicyConfig();
  let executed = false;

  const result = await guardAction({
    config,
    tool: "database.run_sql",
    description: "Run SQL against the application database",
    arguments: { sql: "update users set plan = 'pro' where id = 1" },
    execute: async () => {
      executed = true;
      return { ok: true };
    },
  });

  assert.equal(result.executed, false);
  assert.equal(executed, false);
  assert.equal(result.decision.decision, "require_approval");
  assert.match(result.error ?? "", /no reviewer/);
});

test("guardAction hard-denies destructive database SQL before execution", async () => {
  const config = defaultPolicyConfig();
  config.defaults.destructive = "deny";
  let executed = false;

  const result = await guardAction({
    config,
    tool: "database.run_sql",
    description: "Run SQL against the production database",
    arguments: { sql: "drop table users" },
    execute: async () => {
      executed = true;
      return { ok: true };
    },
  });

  assert.equal(result.executed, false);
  assert.equal(executed, false);
  assert.equal(result.decision.decision, "deny");
  assert.deepEqual(result.classification.labels, [
    "write",
    "destructive",
    "sensitive_data",
  ]);
  assert.match(result.error ?? "", /denied by policy/);
});

test("guardAction can approve controlled SQL writes and audit final args", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-sdk-"));
  const auditPath = join(dir, "audit.jsonl");
  const config = defaultPolicyConfig();
  const reviewer: ApprovalReviewer = {
    review: async () => ({ action: "approve", approver: "admin" }),
  };

  try {
    const result = await guardAction({
      config,
      tool: "database.run_sql",
      description: "Run SQL against the application database",
      arguments: { sql: "insert into notes (body) values ('hello')" },
      execute: async () => ({ inserted: 1 }),
      reviewer,
      auditPath,
    });

    assert.equal(result.executed, true);
    assert.equal(result.approval?.status, "approved");
    assert.deepEqual(result.output, { inserted: 1 });

    const events = readAuditEvents(auditPath);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.tool, "database.run_sql");
    assert.deepEqual(events[0]?.executedArguments, {
      sql: "insert into notes (body) values ('hello')",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guardAction records executor failures as attempted actions", async () => {
  const config = defaultPolicyConfig();

  const result = await guardAction({
    config,
    tool: "database.run_sql",
    description: "Run SQL against the application database",
    arguments: { sql: "select * from missing_table" },
    execute: async () => {
      throw new Error("relation missing_table does not exist");
    },
  });

  assert.equal(result.executed, true);
  assert.equal(result.auditEvent.responseStatus, "error");
  assert.equal(result.error, "relation missing_table does not exist");
  assert.deepEqual(result.output, {
    error: "relation missing_table does not exist",
  });
});
