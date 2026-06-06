import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface TelegramCredentials {
  token: string;
  chatId: number;
  botUsername?: string;
}

export function defaultTelegramCredentialsPath(): string {
  return join(homedir(), ".warden", "telegram.json");
}

/**
 * Loads Telegram credentials from the environment (WARDEN_TELEGRAM_TOKEN +
 * WARDEN_TELEGRAM_CHAT_ID) or the credentials file. Returns undefined when no
 * usable credentials exist.
 */
export function loadTelegramCredentials(
  path: string = defaultTelegramCredentialsPath(),
): TelegramCredentials | undefined {
  const envToken = process.env["WARDEN_TELEGRAM_TOKEN"];
  const envChat = process.env["WARDEN_TELEGRAM_CHAT_ID"];
  if (envToken && envChat) {
    const chatId = Number(envChat);
    if (Number.isFinite(chatId)) {
      return { token: envToken, chatId };
    }
  }

  let parsed: Partial<TelegramCredentials>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TelegramCredentials>;
  } catch {
    return undefined;
  }

  if (typeof parsed.token !== "string" || typeof parsed.chatId !== "number") {
    return undefined;
  }

  const credentials: TelegramCredentials = {
    token: parsed.token,
    chatId: parsed.chatId,
  };
  if (typeof parsed.botUsername === "string") {
    credentials.botUsername = parsed.botUsername;
  }
  return credentials;
}

export function saveTelegramCredentials(
  credentials: TelegramCredentials,
  path: string = defaultTelegramCredentialsPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
