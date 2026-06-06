import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { promptReviewer } from "../src/approval/prompt.js";
import type { ApprovalRequest } from "../src/domain/types.js";

function makeRequest(): ApprovalRequest {
  return {
    id: "appr_test",
    runId: "run_test",
    callId: "call_test",
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    tool: "openai.send_discount_email",
    riskLabels: ["external_send"],
    policyRule: "defaults.external_send",
    originalArguments: { to: "taylor@example.com" },
    displayArguments: { to: "taylor@example.com" },
    status: "pending",
  };
}

function tty(): PassThrough & { isTTY: boolean } {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean };
  stream.isTTY = true;
  return stream;
}

test("promptReviewer approves on a 'y' answer and records the approver", async () => {
  const input = tty();
  const output = new PassThrough();
  const review = promptReviewer({ input, output, approver: "tester" }).review(
    makeRequest(),
  );
  input.write("y\n");

  const action = await review;
  assert.equal(action.action, "approve");
  assert.equal(action.approver, "tester");
});

test("promptReviewer denies on a blank/no answer", async () => {
  const input = tty();
  const output = new PassThrough();
  const review = promptReviewer({ input, output }).review(makeRequest());
  input.write("\n");

  const action = await review;
  assert.equal(action.action, "reject");
});

test("promptReviewer fails closed when no TTY is attached", async () => {
  const input = new PassThrough(); // isTTY is undefined/falsy
  const output = new PassThrough();
  const action = await promptReviewer({ input, output }).review(makeRequest());

  assert.equal(action.action, "reject");
  assert.equal(action.approver, "warden");
  assert.match(action.reason ?? "", /TTY/);
});

test("promptReviewer shows the redacted tool and risk in the prompt", async () => {
  const input = tty();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk) => {
    printed += String(chunk);
  });

  const review = promptReviewer({ input, output }).review(makeRequest());
  input.write("n\n");
  await review;

  assert.match(printed, /openai\.send_discount_email/);
  assert.match(printed, /external_send/);
  assert.match(printed, /Approve this action\?/);
});
