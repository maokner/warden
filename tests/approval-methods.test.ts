import test from "node:test";
import assert from "node:assert/strict";
import {
  callbackReviewer,
  denyReviewer,
  parseTimeout,
} from "../src/approval/methods.js";
import type { ApprovalRequest } from "../src/domain/types.js";

const fakeRequest = {} as unknown as ApprovalRequest;

test("parseTimeout maps presets and integers", () => {
  assert.equal(parseTimeout("0s"), 0);
  assert.equal(parseTimeout("30s"), 30);
  assert.equal(parseTimeout("1m"), 60);
  assert.equal(parseTimeout("1h"), 3600);
  assert.equal(parseTimeout("45"), 45);
  assert.equal(parseTimeout(120), 120);
});

test("parseTimeout rejects invalid values", () => {
  assert.throws(() => parseTimeout("none"), /timeout/);
  assert.throws(() => parseTimeout("soon"), /timeout/);
  assert.throws(() => parseTimeout(-5), /non-negative/);
  assert.throws(() => parseTimeout(1.5), /non-negative/);
});

test("denyReviewer always rejects", async () => {
  const action = await denyReviewer().review(fakeRequest);
  assert.equal(action.action, "reject");
  assert.match(action.reason ?? "", /deny/);
});

test("callbackReviewer maps an approval decision", async () => {
  const reviewer = callbackReviewer(() => ({
    decision: "approve",
    approver: "bob",
    reason: "looks fine",
  }));
  const action = await reviewer.review(fakeRequest);

  assert.equal(action.action, "approve");
  assert.equal(action.approver, "bob");
  assert.equal(action.reason, "looks fine");
});

test("callbackReviewer defaults the approver and maps edits", async () => {
  const reviewer = callbackReviewer(async () => ({
    decision: "edit",
    editedArguments: { sql: "select 1" },
  }));
  const action = await reviewer.review(fakeRequest);

  assert.equal(action.action, "edit");
  assert.equal(action.approver, "callback");
  if (action.action === "edit") {
    assert.deepEqual(action.editedArguments, { sql: "select 1" });
  }
});
