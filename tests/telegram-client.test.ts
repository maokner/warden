import test from "node:test";
import assert from "node:assert/strict";
import { TelegramClient } from "../src/telegram/client.js";
import { startFakeTelegram } from "./fixtures/fake-telegram.js";

test("TelegramClient.getMe and sendPoll talk to the Bot API", async () => {
  const fake = await startFakeTelegram({ botUsername: "demo_bot" });
  try {
    const client = new TelegramClient({ token: "T", apiBaseUrl: fake.url });

    const me = await client.getMe();
    assert.equal(me.username, "demo_bot");

    const poll = await client.sendPoll(123, "Approve this action?", [
      "✅ Approve",
      "❌ Deny",
    ]);
    assert.equal(typeof poll.pollId, "string");
    assert.equal(fake.sentPolls.length, 1);
    assert.equal(fake.sentPolls[0]?.chatId, 123);
  } finally {
    await fake.close();
  }
});

test("TelegramClient.getUpdates parses queued updates", async () => {
  const fake = await startFakeTelegram();
  try {
    const client = new TelegramClient({ token: "T", apiBaseUrl: fake.url });
    fake.enqueueUpdate({
      update_id: 7,
      poll_answer: { poll_id: "poll_1", option_ids: [0], user: { id: 5 } },
    });

    const updates = await client.getUpdates();
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.poll_answer?.poll_id, "poll_1");
  } finally {
    await fake.close();
  }
});

test("TelegramClient throws on a Bot API error", async () => {
  const fake = await startFakeTelegram();
  try {
    const client = new TelegramClient({ token: "T", apiBaseUrl: fake.url });
    await assert.rejects(client.sendMessage(1, "__FAIL__"), /forced failure/);
  } finally {
    await fake.close();
  }
});
