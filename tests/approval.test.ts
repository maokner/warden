import test from "node:test";
import assert from "node:assert/strict";
import {
  createApprovalRequest,
  resolveApproval,
  type ApprovalReviewer,
} from "../src/approval/approval.js";
import { makeToolRef } from "../src/domain/tool-ref.js";

test("createApprovalRequest redacts display arguments but preserves original", () => {
  const request = createApprovalRequest({
    call: {
      ref: makeToolRef("filesystem", "write_file"),
      arguments: {
        path: "src/config.ts",
        token: "secret",
      },
      runId: "run_1",
      callId: "call_1",
    },
    decision: {
      decision: "require_approval",
      reason: "write -> require_approval",
      rule: "defaults.write",
      riskLabels: ["write", "file_mutation"],
      approval: { timeoutSeconds: 60 },
    },
    redactionFields: ["token"],
    now: new Date("2026-06-05T00:00:00.000Z"),
  });

  assert.equal(request.runId, "run_1");
  assert.equal(request.callId, "call_1");
  assert.equal(request.status, "pending");
  assert.equal(request.createdAt, "2026-06-05T00:00:00.000Z");
  assert.equal(request.expiresAt, "2026-06-05T00:01:00.000Z");
  assert.deepEqual(request.originalArguments, {
    path: "src/config.ts",
    token: "secret",
  });
  assert.deepEqual(request.displayArguments, {
    path: "src/config.ts",
    token: "[REDACTED]",
  });
});

test("resolveApproval approves exact original arguments", async () => {
  const request = sampleRequest();
  const reviewer: ApprovalReviewer = {
    review: async () => ({ action: "approve", approver: "human" }),
  };

  const resolution = await resolveApproval(request, reviewer, {
    now: new Date("2026-06-05T00:00:01.000Z"),
  });

  assert.equal(resolution.status, "approved");
  assert.equal(resolution.approver, "human");
  assert.deepEqual(resolution.finalArguments, request.originalArguments);
});

test("resolveApproval rejects without final arguments", async () => {
  const request = sampleRequest();
  const reviewer: ApprovalReviewer = {
    review: async () => ({
      action: "reject",
      approver: "human",
      reason: "too broad",
    }),
  };

  const resolution = await resolveApproval(request, reviewer, {
    now: new Date("2026-06-05T00:00:01.000Z"),
  });

  assert.equal(resolution.status, "rejected");
  assert.equal(resolution.reason, "too broad");
  assert.equal("finalArguments" in resolution, false);
});

test("resolveApproval supports edit-and-approve while preserving original", async () => {
  const request = sampleRequest();
  const reviewer: ApprovalReviewer = {
    review: async () => ({
      action: "edit",
      approver: "human",
      editedArguments: { path: "docs/safe.md", content: "hello" },
    }),
  };

  const resolution = await resolveApproval(request, reviewer, {
    now: new Date("2026-06-05T00:00:01.000Z"),
  });

  assert.equal(resolution.status, "edited_and_approved");
  assert.deepEqual(resolution.originalArguments, {
    path: "src/config.ts",
    content: "hello",
  });
  assert.deepEqual(resolution.finalArguments, {
    path: "docs/safe.md",
    content: "hello",
  });
});

test("resolveApproval expires already expired requests before review", async () => {
  let called = false;
  const request = sampleRequest();
  const reviewer: ApprovalReviewer = {
    review: async () => {
      called = true;
      return { action: "approve", approver: "human" };
    },
  };

  const resolution = await resolveApproval(request, reviewer, {
    now: new Date("2026-06-05T00:02:00.000Z"),
  });

  assert.equal(resolution.status, "expired");
  assert.equal(called, false);
  assert.equal("finalArguments" in resolution, false);
});

test("resolveApproval fails closed when reviewer does not answer before timeout", async () => {
  const request = createApprovalRequest({
    call: {
      ref: makeToolRef("filesystem", "write_file"),
      arguments: { path: "src/config.ts", content: "hello" },
    },
    decision: {
      decision: "require_approval",
      reason: "write -> require_approval",
      rule: "defaults.write",
      riskLabels: ["write"],
      approval: { timeoutSeconds: 1 },
    },
    redactionFields: [],
    now: new Date("2026-06-05T00:00:00.000Z"),
  });
  const reviewer: ApprovalReviewer = {
    review: async () =>
      new Promise((resolve) => {
        setTimeout(
          () => resolve({ action: "approve", approver: "human" }),
          50,
        );
      }),
  };

  const resolution = await resolveApproval(request, reviewer, {
    now: new Date("2026-06-05T00:00:00.999Z"),
  });

  assert.equal(resolution.status, "expired");
});

test("resolveApproval fails when approver identity is missing", async () => {
  const request = sampleRequest();
  const reviewer: ApprovalReviewer = {
    review: async () => ({ action: "approve", approver: "" }),
  };

  const resolution = await resolveApproval(request, reviewer, {
    now: new Date("2026-06-05T00:00:01.000Z"),
  });

  assert.equal(resolution.status, "failed");
  assert.match(resolution.reason ?? "", /approver identity/);
});

test("resolveApproval enforces allowed approvers", async () => {
  const request = createApprovalRequest({
    call: {
      ref: makeToolRef("filesystem", "write_file"),
      arguments: { path: "src/config.ts", content: "hello" },
    },
    decision: {
      decision: "require_approval",
      reason: "write -> require_approval",
      rule: "tools.filesystem.write_file.approval",
      riskLabels: ["write"],
      approval: {
        timeoutSeconds: 60,
        approvers: ["alice"],
      },
    },
    redactionFields: [],
    now: new Date("2026-06-05T00:00:00.000Z"),
  });
  const reviewer: ApprovalReviewer = {
    review: async () => ({ action: "approve", approver: "bob" }),
  };

  const resolution = await resolveApproval(request, reviewer, {
    now: new Date("2026-06-05T00:00:01.000Z"),
  });

  assert.equal(resolution.status, "failed");
  assert.match(resolution.reason ?? "", /not allowed/);
  assert.equal("finalArguments" in resolution, false);
});

test("resolveApproval accepts bare Telegram usernames in approver policies", async () => {
  const request = createApprovalRequest({
    call: {
      ref: makeToolRef("filesystem", "write_file"),
      arguments: { path: "src/config.ts", content: "hello" },
    },
    decision: {
      decision: "require_approval",
      reason: "write -> require_approval",
      rule: "tools.filesystem.write_file.approval",
      riskLabels: ["write"],
      approval: {
        timeoutSeconds: 60,
        approvers: ["alice"],
      },
    },
    redactionFields: [],
    now: new Date("2026-06-05T00:00:00.000Z"),
  });
  const reviewer: ApprovalReviewer = {
    review: async () => ({ action: "approve", approver: "telegram:alice" }),
  };

  const resolution = await resolveApproval(request, reviewer, {
    now: new Date("2026-06-05T00:00:01.000Z"),
  });

  assert.equal(resolution.status, "approved");
});

test("resolveApproval requires reasons for executing approvals when configured", async () => {
  const request = createApprovalRequest({
    call: {
      ref: makeToolRef("filesystem", "write_file"),
      arguments: { path: "src/config.ts", content: "hello" },
    },
    decision: {
      decision: "require_approval",
      reason: "write -> require_approval",
      rule: "tools.filesystem.write_file.approval",
      riskLabels: ["write"],
      approval: {
        timeoutSeconds: 60,
        requireReason: true,
      },
    },
    redactionFields: [],
    now: new Date("2026-06-05T00:00:00.000Z"),
  });
  const reviewer: ApprovalReviewer = {
    review: async () => ({ action: "approve", approver: "human" }),
  };

  const resolution = await resolveApproval(request, reviewer, {
    now: new Date("2026-06-05T00:00:01.000Z"),
  });

  assert.equal(resolution.status, "failed");
  assert.match(resolution.reason ?? "", /requires a reason/);
});

function sampleRequest() {
  return createApprovalRequest({
    call: {
      ref: makeToolRef("filesystem", "write_file"),
      arguments: { path: "src/config.ts", content: "hello" },
      runId: "run_1",
      callId: "call_1",
    },
    decision: {
      decision: "require_approval",
      reason: "write -> require_approval",
      rule: "defaults.write",
      riskLabels: ["write"],
      approval: { timeoutSeconds: 60 },
    },
    redactionFields: [],
    now: new Date("2026-06-05T00:00:00.000Z"),
  });
}
