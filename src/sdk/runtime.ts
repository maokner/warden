import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ApprovalMethod, PolicyConfig } from "../domain/types.js";
import type { ApprovalReviewer } from "../approval/approval.js";
import {
  callbackReviewer,
  denyReviewer,
  type ApprovalCallback,
} from "../approval/methods.js";
import { promptReviewer } from "../approval/prompt.js";
import { TelegramApprovalChannel } from "../approval/telegram.js";
import { TelegramClient, type TelegramClientOptions } from "../telegram/client.js";
import { loadTelegramCredentials } from "../telegram/credentials.js";
import { loadPolicyConfig } from "../policy/config.js";
import { defaultPolicyConfig } from "../policy/defaults.js";

export interface ConfigureWardenOptions {
  config?: PolicyConfig;
  configPath?: string;
  cwd?: string;
  auditPath?: string | false;
  approval?: {
    method?: ApprovalMethod;
    onApproval?: ApprovalCallback;
    token?: string;
    chatId?: number;
    credentialsPath?: string;
    apiBaseUrl?: string;
  };
}

export interface WardenRuntime {
  config: PolicyConfig;
  auditPath: string | undefined;
  reviewer: ApprovalReviewer | undefined;
  close: () => void;
}

let current: WardenRuntime | undefined;

export function configureWarden(
  options: ConfigureWardenOptions = {},
): WardenRuntime {
  current?.close();

  const cwd = options.cwd ?? process.cwd();
  const config = resolveConfig(options, cwd);
  const auditPath =
    options.auditPath === false
      ? undefined
      : options.auditPath ?? resolve(cwd, config.auditPath);

  const method = resolveMethod(options, config);
  const channel = resolveChannel(method, options);

  const runtime: WardenRuntime = {
    config,
    auditPath,
    reviewer: channel.reviewer,
    close: () => {
      void channel.telegram?.stop();
      if (current === runtime) {
        current = undefined;
      }
    },
  };

  current = runtime;
  return runtime;
}

export function getWardenRuntime(): WardenRuntime {
  if (!current) {
    current = configureWarden();
  }
  return current;
}

/** Returns the configured runtime without lazily creating a default one. */
export function peekWardenRuntime(): WardenRuntime | undefined {
  return current;
}

export function resetWarden(): void {
  current?.close();
  current = undefined;
}

function resolveConfig(options: ConfigureWardenOptions, cwd: string): PolicyConfig {
  if (options.config) {
    return options.config;
  }
  if (options.configPath) {
    return loadPolicyConfig(resolve(cwd, options.configPath));
  }
  const local = resolve(cwd, "warden.yaml");
  if (existsSync(local)) {
    return loadPolicyConfig(local);
  }
  return defaultPolicyConfig();
}

function resolveMethod(
  options: ConfigureWardenOptions,
  config: PolicyConfig,
): ApprovalMethod {
  if (options.approval?.method) {
    return options.approval.method;
  }
  if (options.approval?.onApproval) {
    return "callback";
  }
  return config.approval.method;
}

interface ApprovalChannel {
  reviewer: ApprovalReviewer | undefined;
  telegram?: TelegramApprovalChannel;
}

function denyChannel(): ApprovalChannel {
  return { reviewer: denyReviewer() };
}

function resolveChannel(
  method: ApprovalMethod,
  options: ConfigureWardenOptions,
): ApprovalChannel {
  if (method === "callback") {
    const onApproval = options.approval?.onApproval;
    if (!onApproval) {
      process.stderr.write(
        "Warden: approval method is `callback` but no onApproval was provided; failing closed (deny).\n",
      );
      return denyChannel();
    }
    return { reviewer: callbackReviewer(onApproval) };
  }

  if (method === "prompt") {
    return { reviewer: promptReviewer() };
  }

  if (method === "telegram") {
    return resolveTelegramChannel(options);
  }

  return denyChannel();
}

function resolveTelegramChannel(options: ConfigureWardenOptions): ApprovalChannel {
  const credentials = loadTelegramCredentials(options.approval?.credentialsPath);
  const token = options.approval?.token ?? credentials?.token;
  const chatId = options.approval?.chatId ?? credentials?.chatId;

  if (!token || chatId === undefined) {
    process.stderr.write(
      "Warden: approval method is `telegram` but no bot token / chat id is configured. Run `warden login --token <bot-token>` or set WARDEN_TELEGRAM_TOKEN and WARDEN_TELEGRAM_CHAT_ID; failing closed (deny).\n",
    );
    return denyChannel();
  }

  const clientOptions: TelegramClientOptions = { token };
  if (options.approval?.apiBaseUrl) {
    clientOptions.apiBaseUrl = options.approval.apiBaseUrl;
  }
  const channel = new TelegramApprovalChannel({
    client: new TelegramClient(clientOptions),
    chatId,
  });
  channel.start();

  return {
    reviewer: channel,
    telegram: channel,
  };
}
