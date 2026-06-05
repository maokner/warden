import { PassThrough } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";
import { createTerminalReviewer } from "../src/approval/terminal.js";
import { createApprovalRequest } from "../src/approval/approval.js";
import { makeToolRef } from "../src/domain/tool-ref.js";

test("terminal reviewer supports edit-and-approve with JSON arguments", async () => {
  const { input, output, outputText } = terminalStreams();
  try {
    const reviewer = createTerminalReviewer({
      input,
      output,
      approver: "human",
    });

    const review = reviewer.review(sampleRequest());
    input.write("e\n");
    await waitForOutput(outputText, /Edited arguments JSON object/);
    input.write('{"path":"docs/safe.md","content":"hello"}\n');

    const action = await review;

    assert.equal(action.action, "edit");
    assert.equal(action.approver, "human");
    if (action.action === "edit") {
      assert.deepEqual(action.editedArguments, {
        path: "docs/safe.md",
        content: "hello",
      });
    }
    assert.match(outputText(), /Warden approval required/);
    assert.match(outputText(), /Edited arguments JSON object/);
  } finally {
    input.destroy();
    output.destroy();
  }
});

test("terminal reviewer rejects invalid edited JSON and keeps prompting", async () => {
  const { input, output, outputText } = terminalStreams();
  try {
    const reviewer = createTerminalReviewer({
      input,
      output,
      approver: "human",
    });

    const review = reviewer.review(sampleRequest());
    input.write("e\n");
    await waitForOutput(outputText, /Edited arguments JSON object/);
    input.write("[]\n");
    await waitForOutput(outputText, /Edited arguments must be a valid JSON object/);
    input.write("a\n");

    const action = await review;

    assert.equal(action.action, "approve");
    assert.match(outputText(), /Edited arguments must be a valid JSON object/);
  } finally {
    input.destroy();
    output.destroy();
  }
});

function terminalStreams(): {
  input: PassThrough;
  output: PassThrough;
  outputText: () => string;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];

  output.on("data", (chunk) => {
    chunks.push(String(chunk));
  });

  return {
    input,
    output,
    outputText: () => chunks.join(""),
  };
}

async function waitForOutput(
  outputText: () => string,
  pattern: RegExp,
): Promise<void> {
  const expiresAt = Date.now() + 1_000;

  while (!pattern.test(outputText())) {
    if (Date.now() >= expiresAt) {
      throw new Error(`Timed out waiting for output matching ${String(pattern)}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

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
