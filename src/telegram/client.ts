import type { JsonObject } from "../domain/types.js";

export interface TelegramClientOptions {
  token: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  text?: string;
  chat: { id: number; type?: string };
  from?: TelegramUser;
}

export interface TelegramPollAnswer {
  poll_id: string;
  option_ids: number[];
  user?: TelegramUser;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  poll_answer?: TelegramPollAnswer;
}

export interface SentPoll {
  messageId: number;
  pollId: string;
}

const DEFAULT_API_BASE_URL = "https://api.telegram.org";

/** Minimal Telegram Bot API client over plain HTTPS (long-polling, no deps). */
export class TelegramClient {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TelegramClientOptions) {
    this.token = options.token;
    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getMe(): Promise<TelegramUser> {
    return (await this.call("getMe")) as TelegramUser;
  }

  async getUpdates(params: {
    offset?: number | undefined;
    timeoutSeconds?: number | undefined;
    signal?: AbortSignal | undefined;
  } = {}): Promise<TelegramUpdate[]> {
    const body: JsonObject = { timeout: params.timeoutSeconds ?? 0 };
    if (params.offset !== undefined) {
      body["offset"] = params.offset;
    }
    return (await this.call("getUpdates", body, params.signal)) as TelegramUpdate[];
  }

  async sendMessage(chatId: number | string, text: string): Promise<TelegramMessage> {
    return (await this.call("sendMessage", { chat_id: chatId, text })) as TelegramMessage;
  }

  async sendPoll(
    chatId: number | string,
    question: string,
    options: string[],
  ): Promise<SentPoll> {
    const result = (await this.call("sendPoll", {
      chat_id: chatId,
      question,
      options: options.map((text) => ({ text })),
      is_anonymous: false,
    })) as { message_id: number; poll: { id: string } };

    return { messageId: result.message_id, pollId: result.poll.id };
  }

  async stopPoll(chatId: number | string, messageId: number): Promise<void> {
    await this.call("stopPoll", { chat_id: chatId, message_id: messageId });
  }

  async deleteWebhook(): Promise<void> {
    await this.call("deleteWebhook", {});
  }

  private async call(
    method: string,
    body?: JsonObject,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    if (signal !== undefined) {
      init.signal = signal;
    }

    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/bot${this.token}/${method}`,
      init,
    );
    const payload = (await response.json()) as {
      ok: boolean;
      result?: unknown;
      description?: string;
    };

    if (!payload.ok) {
      throw new Error(
        `Telegram ${method} failed: ${payload.description ?? `HTTP ${response.status}`}`,
      );
    }

    return payload.result;
  }
}
