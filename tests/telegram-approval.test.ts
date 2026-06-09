import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalRequest, resolveApproval } from "../src/approval/approval.js";
import { TelegramApprovalChannel } from "../src/approval/telegram.js";
import { TelegramClient } from "../src/telegram/client.js";
import { makeToolRef } from "../src/domain/tool-ref.js";
import type { ApprovalRequest, JsonObject } from "../src/domain/types.js";
import { startFakeTelegram, type FakeTelegram } from "./fixtures/fake-telegram.js";

function makeRequest(args: JsonObject, timeoutSeconds: number): ApprovalRequest {
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

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeChannel(fake: FakeTelegram): TelegramApprovalChannel {
  const client = new TelegramClient({ token: "T", apiBaseUrl: fake.url });
  const channel = new TelegramApprovalChannel({ client, chatId: 555 });
  channel.start();
  return channel;
}

test("Telegram channel approves on the first vote and sends only redacted args", async () => {
  const fake = await startFakeTelegram();
  const channel = makeChannel(fake);

  try {
    const resolution = resolveApproval(
      makeRequest({ sql: "update users set x = 1", password: "hunter2" }, 60),
      channel,
    );
    await until(() => fake.sentPolls.length > 0);

    assert.match(fake.sentMessages[0]?.text ?? "", /\[REDACTED\]/);
    assert.doesNotMatch(fake.sentMessages[0]?.text ?? "", /hunter2/);

    fake.enqueueUpdate({
      update_id: 1,
      poll_answer: {
        poll_id: fake.sentPolls[0]?.pollId,
        option_ids: [0],
        user: { id: 555, username: "alice" },
      },
    });

    const result = await resolution;
    assert.equal(result.status, "approved");
    assert.equal(result.approver, "telegram:alice");
    await until(() => fake.stopPolls.length > 0);
    assert.equal(fake.stopPolls.length, 1);
  } finally {
    await channel.stop();
    await fake.close();
  }
});

test("Telegram channel rejects on a deny vote", async () => {
  const fake = await startFakeTelegram();
  const channel = makeChannel(fake);

  try {
    const resolution = resolveApproval(makeRequest({ sql: "update x" }, 60), channel);
    await until(() => fake.sentPolls.length > 0);

    fake.enqueueUpdate({
      update_id: 1,
      poll_answer: {
        poll_id: fake.sentPolls[0]?.pollId,
        option_ids: [1],
        user: { id: 555 },
      },
    });

    const result = await resolution;
    assert.equal(result.status, "rejected");
  } finally {
    await channel.stop();
    await fake.close();
  }
});

test("Telegram channel fails closed when no one votes before the timeout", async () => {
  const fake = await startFakeTelegram();
  const channel = makeChannel(fake);

  try {
    const result = await resolveApproval(makeRequest({ sql: "update x" }, 0.2), channel);
    assert.equal(result.status, "expired");
  } finally {
    await channel.stop();
    await fake.close();
  }
});

test("Telegram channel ignores votes from accounts other than the paired approver", async () => {
  const fake = await startFakeTelegram();
  const channel = makeChannel(fake);

  try {
    const resolution = resolveApproval(makeRequest({ sql: "update x" }, 0.5), channel);
    await until(() => fake.sentPolls.length > 0);

    fake.enqueueUpdate({
      update_id: 1,
      poll_answer: {
        poll_id: fake.sentPolls[0]?.pollId,
        option_ids: [0],
        user: { id: 9999, username: "mallory" },
      },
    });

    const result = await resolution;
    assert.equal(result.status, "expired");
  } finally {
    await channel.stop();
    await fake.close();
  }
});

test("Telegram channel stop() resolves in-flight reviews instead of hanging them", async () => {
  const fake = await startFakeTelegram();
  const channel = makeChannel(fake);

  const resolution = resolveApproval(makeRequest({ sql: "update x" }, 60), channel);
  await until(() => fake.sentPolls.length > 0);
  await channel.stop();

  const result = await resolution;
  assert.equal(result.status, "rejected");
  assert.match(result.reason ?? "", /channel stopped/);
  await fake.close();
});

test("Telegram channel clears any leftover webhook before long-polling", async () => {
  const fake = await startFakeTelegram();
  const channel = makeChannel(fake);

  try {
    await until(() => fake.deleteWebhookCalls.length > 0);
    assert.ok(fake.deleteWebhookCalls.length > 0);
  } finally {
    await channel.stop();
    await fake.close();
  }
});
