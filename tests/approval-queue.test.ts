import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalRequest } from "../src/approval/approval.js";
import { ApprovalQueue } from "../src/approval/queue.js";
import { makeToolRef } from "../src/domain/tool-ref.js";
import type { ApprovalRequest, JsonObject } from "../src/domain/types.js";

function makeRequest(
  args: JsonObject = { sql: "update users set x = 1", password: "hunter2" },
  timeoutSeconds = 60,
): ApprovalRequest {
  const ref = makeToolRef("db", "run_sql");
  return createApprovalRequest({
    call: {
      ref,
      arguments: args,
      metadata: { ref, description: "", inputSchema: {}, annotations: {} },
    },
    decision: {
      decision: "require_approval",
      reason: "needs review",
      rule: "defaults.write",
      riskLabels: ["write"],
      approval: { timeoutSeconds },
    },
    redactionFields: ["password"],
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("ApprovalQueue resolves a parked review when approved", async () => {
  const queue = new ApprovalQueue();
  const request = makeRequest();
  const review = queue.review(request);

  assert.equal(queue.list().length, 1);
  assert.equal(queue.approve(request.id, { approver: "alice", reason: "ok" }), true);

  const action = await review;
  assert.equal(action.action, "approve");
  assert.equal(action.approver, "alice");
  assert.equal(action.reason, "ok");
  assert.equal(queue.list().length, 0);
});

test("ApprovalQueue maps reject and edit", async () => {
  const queue = new ApprovalQueue();

  const rejectReq = makeRequest();
  const rejectReview = queue.review(rejectReq);
  queue.reject(rejectReq.id, { approver: "bob" });
  assert.equal((await rejectReview).action, "reject");

  const editReq = makeRequest();
  const editReview = queue.review(editReq);
  queue.edit(editReq.id, { sql: "select 1" }, { approver: "carol" });
  const editAction = await editReview;
  assert.equal(editAction.action, "edit");
  if (editAction.action === "edit") {
    assert.deepEqual(editAction.editedArguments, { sql: "select 1" });
  }
});

test("ApprovalQueue.list exposes only redacted arguments", () => {
  const queue = new ApprovalQueue();
  void queue.review(makeRequest({ sql: "update x", password: "hunter2" }));

  const [view] = queue.list();
  assert.ok(view);
  assert.equal(view.displayArguments["password"], "[REDACTED]");
  assert.equal("originalArguments" in view, false);
});

test("ApprovalQueue prunes entries once they expire", async () => {
  const queue = new ApprovalQueue();
  const request = makeRequest({ sql: "x" }, 0); // expires immediately
  void queue.review(request);

  await tick();
  assert.equal(queue.list().length, 0);
  assert.equal(queue.approve(request.id), false);
});
