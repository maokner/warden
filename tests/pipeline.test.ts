import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import type { ApprovalReviewer } from "../src/approval/approval.js";
import { makeToolRef } from "../src/domain/tool-ref.js";
import type { JsonValue, ToolCall } from "../src/domain/types.js";
import { defaultPolicyConfig } from "../src/policy/defaults.js";
import { handleToolCall, type ToolExecutor } from "../src/pipeline/handle-tool-call.js";
import { toolMetadata } from "./helpers.js";

test("handleToolCall executes allowed read calls and audits success", async () => {
  const config = defaultPolicyConfig();
  const executor = recordingExecutor();
  const call = callFor("filesystem.read_file", "Read a file", { path: "README.md" });

  const result = await handleToolCall({ config, call, executor });

  assert.equal(result.executed, true);
  assert.equal(result.decision.decision, "allow");
  assert.equal(executor.calls.length, 1);
  assert.equal(result.auditEvent.responseStatus, "success");
  assert.deepEqual(result.auditEvent.executedArguments, { path: "README.md" });
});

test("handleToolCall does not execute denied calls", async () => {
  const config = defaultPolicyConfig();
  const executor = recordingExecutor();
  const call = callFor("stripe.create_refund", "Refund a payment", {
    payment_intent: "pi_123",
  });

  const result = await handleToolCall({ config, call, executor });

  assert.equal(result.executed, false);
  assert.equal(result.decision.decision, "deny");
  assert.equal(executor.calls.length, 0);
  assert.equal(result.auditEvent.responseStatus, "not_executed");
});

test("handleToolCall fails closed when approval is required but no reviewer exists", async () => {
  const config = defaultPolicyConfig();
  const executor = recordingExecutor();
  const call = callFor("filesystem.write_file", "Write a file", {
    path: "src/config.ts",
    content: "hello",
  });

  const result = await handleToolCall({ config, call, executor });

  assert.equal(result.executed, false);
  assert.equal(result.decision.decision, "require_approval");
  assert.equal(executor.calls.length, 0);
  assert.match(result.error ?? "", /no reviewer/);
});

test("handleToolCall executes approved calls", async () => {
  const config = defaultPolicyConfig();
  const executor = recordingExecutor();
  const reviewer: ApprovalReviewer = {
    review: async () => ({ action: "approve", approver: "human" }),
  };
  const call = callFor("filesystem.write_file", "Write a file", {
    path: "src/config.ts",
    content: "hello",
  });

  const result = await handleToolCall({ config, call, executor, reviewer });

  assert.equal(result.executed, true);
  assert.equal(result.approval?.status, "approved");
  assert.equal(executor.calls.length, 1);
  assert.deepEqual(executor.calls[0]?.arguments, {
    path: "src/config.ts",
    content: "hello",
  });
});

test("handleToolCall does not execute rejected approvals", async () => {
  const config = defaultPolicyConfig();
  const executor = recordingExecutor();
  const reviewer: ApprovalReviewer = {
    review: async () => ({ action: "reject", approver: "human" }),
  };
  const call = callFor("filesystem.write_file", "Write a file", {
    path: "src/config.ts",
    content: "hello",
  });

  const result = await handleToolCall({ config, call, executor, reviewer });

  assert.equal(result.executed, false);
  assert.equal(result.approval?.status, "rejected");
  assert.equal(executor.calls.length, 0);
});

test("handleToolCall executes edited approved arguments and audits final args", async () => {
  const config = defaultPolicyConfig();
  const executor = recordingExecutor();
  const reviewer: ApprovalReviewer = {
    review: async () => ({
      action: "edit",
      approver: "human",
      editedArguments: { path: "docs/safe.md", content: "hello" },
    }),
  };
  const call = callFor("filesystem.write_file", "Write a file", {
    path: "src/config.ts",
    content: "hello",
  });

  const result = await handleToolCall({ config, call, executor, reviewer });

  assert.equal(result.executed, true);
  assert.equal(result.approval?.status, "edited_and_approved");
  assert.deepEqual(executor.calls[0]?.arguments, {
    path: "docs/safe.md",
    content: "hello",
  });
  assert.deepEqual(result.auditEvent.requestArguments, {
    path: "src/config.ts",
    content: "hello",
  });
  assert.deepEqual(result.auditEvent.executedArguments, {
    path: "docs/safe.md",
    content: "hello",
  });
});

test("handleToolCall fails closed when edited arguments introduce denied risks", async () => {
  const config = defaultPolicyConfig();
  const executor = recordingExecutor();
  const reviewer: ApprovalReviewer = {
    review: async () => ({
      action: "edit",
      approver: "human",
      editedArguments: {
        path: "docs/safe.md",
        content: "hello",
        token: "secret",
      },
    }),
  };
  const call = callFor("filesystem.write_file", "Write a file", {
    path: "src/config.ts",
    content: "hello",
  });

  const result = await handleToolCall({ config, call, executor, reviewer });

  assert.equal(result.executed, false);
  assert.equal(result.decision.decision, "deny");
  assert.equal(executor.calls.length, 0);
  assert.match(result.error ?? "", /Edited approval arguments are denied/);
});

test("handleToolCall writes audit events when auditPath is configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-pipeline-"));
  const auditPath = join(dir, "audit.jsonl");

  try {
    const config = defaultPolicyConfig();
    const executor = recordingExecutor();
    const call = callFor("filesystem.read_file", "Read a file", {
      path: "README.md",
    });

    const result = await handleToolCall({
      config,
      call,
      executor,
      auditPath,
    });

    assert.equal(result.executed, true);
    assert.equal(result.auditEvent.tool, "filesystem.read_file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handleToolCall records upstream errors as executed attempts", async () => {
  const config = defaultPolicyConfig();
  const executor: ToolExecutor = {
    execute: async () => ({
      status: "error",
      output: {
        content: [{ type: "text", text: "upstream failed" }],
        isError: true,
      },
      summary: "upstream failed",
      error: "upstream failed",
    }),
  };
  const call = callFor("filesystem.read_file", "Read a file", {
    path: "README.md",
  });

  const result = await handleToolCall({ config, call, executor });

  assert.equal(result.executed, true);
  assert.equal(result.auditEvent.responseStatus, "error");
  assert.equal(result.auditEvent.error, "upstream failed");
  assert.deepEqual(result.output, {
    content: [{ type: "text", text: "upstream failed" }],
    isError: true,
  });
});

test("handleToolCall forwards redacted arguments for redact_then_allow", async () => {
  const config = defaultPolicyConfig();
  config.tools["api.read_payload"] = { decision: "redact_then_allow" };
  config.redaction.fields.push("payload");
  const executor = recordingExecutor();
  const call = callFor("api.read_payload", "Read a payload", {
    content: "password=secret&safe=true",
    payload: "internal value",
    keep: "visible",
  });

  const result = await handleToolCall({ config, call, executor });

  assert.equal(result.executed, true);
  assert.equal(result.decision.decision, "redact_then_allow");
  assert.equal(executor.calls.length, 1);
  assert.deepEqual(executor.calls[0]?.arguments, {
    content: "password=[REDACTED]&safe=true",
    payload: "[REDACTED]",
    keep: "visible",
  });
  assert.deepEqual(result.auditEvent.executedArguments, {
    content: "password=[REDACTED]&safe=true",
    payload: "[REDACTED]",
    keep: "visible",
  });
});

test("handleToolCall fails closed and still audits when the approval channel throws", async () => {
  const config = defaultPolicyConfig();
  const executor = recordingExecutor();
  const reviewer: ApprovalReviewer = {
    review: async () => {
      throw new Error("telegram unreachable");
    },
  };
  const call = callFor("filesystem.write_file", "Write a file", {
    path: "src/config.ts",
    content: "hello",
  });

  const result = await handleToolCall({ config, call, executor, reviewer });

  assert.equal(result.executed, false);
  assert.equal(result.approval?.status, "failed");
  assert.match(result.approval?.reason ?? "", /telegram unreachable/);
  assert.equal(executor.calls.length, 0);
  assert.equal(result.auditEvent.responseStatus, "not_executed");
  assert.match(result.auditEvent.error ?? "", /Approval failed/);
});

test("handleToolCall applies argument rules end to end", async () => {
  const config = defaultPolicyConfig();
  config.tools["billing.update_plan"] = {
    rules: [{ when: { amount: { lte: 50 } }, decision: "allow" }],
  };
  const executor = recordingExecutor();

  const small = await handleToolCall({
    config,
    call: callFor("billing.update_plan", "Update a plan", { amount: 25 }),
    executor,
  });

  assert.equal(small.executed, true);
  assert.equal(small.decision.decision, "allow");
  assert.equal(small.decision.rule, "tools.billing.update_plan.rules[0]");

  const large = await handleToolCall({
    config,
    call: callFor("billing.update_plan", "Update a plan", { amount: 900 }),
    executor,
  });

  assert.equal(large.executed, false);
  assert.equal(large.decision.decision, "require_approval");
  assert.equal(large.decision.rule, "defaults.write");
});

function callFor(tool: string, description: string, args: Record<string, JsonValue>): ToolCall {
  const metadata = toolMetadata(tool, { description });

  return {
    ref: makeToolRef(metadata.ref.upstream, metadata.ref.name),
    metadata,
    arguments: args,
  };
}

function recordingExecutor(): ToolExecutor & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];

  return {
    calls,
    execute: async (call) => {
      calls.push(call);
      return {
        status: "success",
        output: { ok: true },
        summary: "ok",
      };
    },
  };
}
