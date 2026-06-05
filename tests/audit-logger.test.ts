import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  appendAuditEvent,
  createAuditEvent,
  readAuditEvents,
} from "../src/audit/logger.js";
import { makeToolRef } from "../src/domain/tool-ref.js";

test("audit logger writes JSONL events with redacted arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-audit-"));
  const auditPath = join(dir, "nested", "audit.jsonl");

  try {
    mkdirSync(join(dir, "nested"), { recursive: true });
    const event = createAuditEvent({
      call: {
        ref: makeToolRef("github", "create_issue"),
        arguments: {
          title: "Bug",
          token: "ghp_secret",
        },
        runId: "run_1",
        callId: "call_1",
        client: "codex",
        agent: "gpt",
        user: "mokner",
      },
      decision: {
        decision: "require_approval",
        reason: "write -> require_approval",
        rule: "defaults.write",
        riskLabels: ["write"],
      },
      policyVersion: "policy_hash",
      redactionFields: ["token"],
      responseStatus: "not_executed",
    });

    appendAuditEvent(auditPath, event);
    const events = readAuditEvents(auditPath);

    assert.equal(events.length, 1);
    assert.equal(events[0]?.tool, "github.create_issue");
    assert.deepEqual(events[0]?.requestArguments, {
      title: "Bug",
      token: "[REDACTED]",
    });
    assert.deepEqual(events[0]?.redactedPaths, ["$.token"]);
    assert.equal(events[0]?.decision, "require_approval");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
