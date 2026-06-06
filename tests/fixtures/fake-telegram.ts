import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeTelegram {
  url: string;
  close: () => Promise<void>;
  enqueueUpdate: (update: Record<string, unknown>) => void;
  sentMessages: Array<{ chatId: unknown; text: string }>;
  sentPolls: Array<{
    chatId: unknown;
    question: string;
    options: unknown;
    pollId: string;
    messageId: number;
  }>;
  stopPolls: Array<{ chatId: unknown; messageId: unknown }>;
}

/** A local stand-in for api.telegram.org for tests (matches /bot<token>/<method>). */
export async function startFakeTelegram(
  options: { botUsername?: string } = {},
): Promise<FakeTelegram> {
  const botUsername = options.botUsername ?? "warden_test_bot";
  const updates: Record<string, unknown>[] = [];
  const sentMessages: FakeTelegram["sentMessages"] = [];
  const sentPolls: FakeTelegram["sentPolls"] = [];
  const stopPolls: FakeTelegram["stopPolls"] = [];
  let messageIdCounter = 100;
  let pollIdCounter = 0;

  const server = createServer((req, res) => {
    const reply = (value: unknown): void => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    req.on("end", async () => {
      const method = (req.url ?? "").split("/").pop() ?? "";
      const raw = Buffer.concat(chunks).toString("utf8");
      const body: Record<string, any> = raw ? JSON.parse(raw) : {};

      switch (method) {
        case "getMe":
          reply({ ok: true, result: { id: 1, is_bot: true, username: botUsername } });
          return;
        case "deleteWebhook":
          reply({ ok: true, result: true });
          return;
        case "sendMessage":
          if (body["text"] === "__FAIL__") {
            reply({ ok: false, description: "forced failure" });
            return;
          }
          sentMessages.push({ chatId: body["chat_id"], text: String(body["text"] ?? "") });
          reply({ ok: true, result: { message_id: ++messageIdCounter, text: body["text"] } });
          return;
        case "sendPoll": {
          const messageId = ++messageIdCounter;
          const pollId = `poll_${++pollIdCounter}`;
          sentPolls.push({
            chatId: body["chat_id"],
            question: String(body["question"] ?? ""),
            options: body["options"],
            pollId,
            messageId,
          });
          reply({ ok: true, result: { message_id: messageId, poll: { id: pollId } } });
          return;
        }
        case "stopPoll":
          stopPolls.push({ chatId: body["chat_id"], messageId: body["message_id"] });
          reply({ ok: true, result: {} });
          return;
        case "getUpdates":
          if (updates.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            reply({ ok: true, result: [] });
            return;
          }
          reply({ ok: true, result: updates.splice(0, updates.length) });
          return;
        default:
          reply({ ok: false, description: `unknown method ${method}` });
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    enqueueUpdate: (update) => updates.push(update),
    sentMessages,
    sentPolls,
    stopPolls,
  };
}
