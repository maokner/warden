import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApprovalRequest, resolveApproval } from "../src/approval/approval.js";
import { ApprovalQueue } from "../src/approval/queue.js";
import { createApprovalServer } from "../src/approval/server.js";
import { makeToolRef } from "../src/domain/tool-ref.js";
import type { ApprovalRequest, JsonObject } from "../src/domain/types.js";

function makeRequest(args: JsonObject): ApprovalRequest {
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
      approval: { timeoutSeconds: 60 },
    },
    redactionFields: ["password"],
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("approval server lists redacted approvals and approves them over HTTP", async () => {
  const queue = new ApprovalQueue();
  const server = createApprovalServer({ queue });
  const port = await listen(server);

  try {
    const resolution = resolveApproval(
      makeRequest({ sql: "update users set plan = 'pro'", password: "hunter2" }),
      queue,
    );
    await tick();

    const listed = (await (
      await fetch(`http://127.0.0.1:${port}/approvals`)
    ).json()) as {
      approvals: Array<{ id: string; displayArguments: Record<string, unknown> }>;
    };
    assert.equal(listed.approvals.length, 1);
    assert.ok(listed.approvals[0]);
    assert.equal(listed.approvals[0].displayArguments["password"], "[REDACTED]");
    assert.equal("originalArguments" in listed.approvals[0], false);

    const id = listed.approvals[0].id;
    const approveResponse = await fetch(
      `http://127.0.0.1:${port}/approvals/${id}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approver: "alice" }),
      },
    );
    assert.equal(approveResponse.status, 200);

    const result = await resolution;
    assert.equal(result.status, "approved");
    assert.equal(result.approver, "alice");
  } finally {
    server.close();
  }
});

test("approval server resolves edits and returns 404 for unknown ids", async () => {
  const queue = new ApprovalQueue();
  const server = createApprovalServer({ queue });
  const port = await listen(server);

  try {
    const resolution = resolveApproval(makeRequest({ sql: "update x" }), queue);
    await tick();
    const id = queue.list()[0]?.id as string;

    const editResponse = await fetch(`http://127.0.0.1:${port}/approvals/${id}/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ arguments: { sql: "select 1" }, approver: "bob" }),
    });
    assert.equal(editResponse.status, 200);

    const result = await resolution;
    assert.equal(result.status, "edited_and_approved");
    assert.deepEqual(result.finalArguments, { sql: "select 1" });

    const missing = await fetch(`http://127.0.0.1:${port}/approvals/nope/approve`, {
      method: "POST",
    });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test("approval server serves the inbox page", async () => {
  const server = createApprovalServer({ queue: new ApprovalQueue() });
  const port = await listen(server);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await response.text(), /Warden approvals/);
  } finally {
    server.close();
  }
});
