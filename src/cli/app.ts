import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  appendAuditEvent,
  classifyToolCall,
  createAuditEvent,
  defaultPolicyConfig,
  evaluatePolicy,
  hashPolicyConfig,
  loadPolicyConfig,
  loadToolCallFixture,
  readAuditEvents,
} from "../index.js";
import { wardenPolicyTemplate } from "../config/sample-policy.js";
import { wardenAgentTemplate } from "../config/sample-agent.js";
import { parseTimeout, TIMEOUT_PRESET_NAMES } from "../approval/methods.js";
import { APPROVAL_METHODS } from "../domain/types.js";
import { TelegramClient, type TelegramClientOptions } from "../telegram/client.js";
import {
  defaultTelegramCredentialsPath,
  saveTelegramCredentials,
  type TelegramCredentials,
} from "../telegram/credentials.js";

export interface CliIo {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;

  try {
    switch (command) {
      case "init":
        return runInit(rest, io);
      case "policy":
        return runPolicy(rest, io);
      case "audit":
        return runAudit(rest, io);
      case "login":
        return await runLogin(rest, io);
      case "help":
      case "--help":
      case "-h":
      case undefined:
        io.stdout(helpText());
        return 0;
      default:
        io.stderr(`Unknown command: ${command}\n\n${helpText()}`);
        return 1;
    }
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function runInit(args: string[], io: CliIo): number {
  const options = parseOptions(args);
  const force = options.has("--force");
  const policyOnly = options.has("--policy-only");

  const targets: Array<{ path: string; content: string }> = [
    {
      path: resolve(io.cwd, options.value("--path") ?? "warden.yaml"),
      content: applyApprovalOverrides(
        wardenPolicyTemplate(),
        options.value("--approval-method"),
        options.value("--approval-timeout"),
      ),
    },
  ];

  if (!policyOnly) {
    targets.push({
      path: resolve(io.cwd, options.value("--agent") ?? "agent.ts"),
      content: wardenAgentTemplate(),
    });
  }

  if (!force) {
    const existing = targets.find((target) => existsSync(target.path));
    if (existing) {
      io.stderr(
        `${existing.path} already exists. Use --force to overwrite it intentionally.\n`,
      );
      return 1;
    }
  }

  for (const target of targets) {
    writeFileSync(target.path, target.content);
  }

  io.stdout(formatInitResult(targets.map((target) => target.path), policyOnly));
  return 0;
}

function formatInitResult(paths: string[], policyOnly: boolean): string {
  const lines = paths.map((path) => `Created ${path}`);
  lines.push("", "Next:");

  if (policyOnly) {
    lines.push(
      "  1. warden login --token <telegram-bot-token>   # pair an approver (or set approval.method: callback)",
      "  2. configureWarden() once at startup, then wrap your tools:",
      "       const tools = guardTools(rawTools).map(tool);",
    );
  } else {
    lines.push(
      "  1. npm install @openai/agents zod @maokner/warden",
      "  2. export OPENAI_API_KEY=sk-...",
      "  3. warden login --token <telegram-bot-token>   # pair an approver (or set approval.method: callback)",
      "  4. npx tsx agent.ts",
    );
  }

  return `${lines.join("\n")}\n`;
}

function applyApprovalOverrides(
  template: string,
  method: string | undefined,
  timeout: string | undefined,
): string {
  let result = template;

  if (method !== undefined) {
    if (!APPROVAL_METHODS.includes(method as never)) {
      throw new Error(
        `--approval-method must be one of: ${APPROVAL_METHODS.join(", ")}.`,
      );
    }
    // Anchored to the indented key under `approval:` so the option comment
    // (`#   method: ...`) is left untouched.
    result = result.replace(/^(\s+)method: \w+/m, `$1method: ${method}`);
  }

  if (timeout !== undefined) {
    parseTimeout(timeout); // validates preset name or seconds, throws otherwise
    result = result.replace(/^(\s+)timeout: \S+/m, `$1timeout: ${timeout}`);
  }

  return result;
}

function runPolicy(args: string[], io: CliIo): number {
  const [subcommand, ...rest] = args;

  if (subcommand !== "test") {
    io.stderr("Usage: warden policy test <call.json> [--config warden.yaml] [--json] [--audit]\n");
    return 1;
  }

  const options = parseOptions(rest);
  const callPath = options.positionals[0];
  if (!callPath) {
    io.stderr("Usage: warden policy test <call.json> [--config warden.yaml] [--json] [--audit]\n");
    return 1;
  }

  const configPath = options.value("--config") ?? "warden.yaml";
  const config = loadConfig(resolve(io.cwd, configPath), options.has("--config"));
  const call = loadToolCallFixture(resolve(io.cwd, callPath));

  if (!call.metadata) {
    throw new Error("Tool call fixture did not produce metadata.");
  }

  const classification = classifyToolCall(call.metadata, call.arguments);
  const decision = evaluatePolicy(config, call.ref.fullName, classification);
  const policyVersion = hashPolicyConfig(config);

  if (options.has("--audit")) {
    appendAuditEvent(
      resolve(io.cwd, config.auditPath),
      createAuditEvent({
        call,
        decision,
        policyVersion,
        redactionFields: config.redaction.fields,
      }),
    );
  }

  if (options.has("--json")) {
    io.stdout(
      `${JSON.stringify(
        {
          tool: call.ref.fullName,
          classification,
          decision,
          policyVersion,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  io.stdout(formatPolicyTest(call.ref.fullName, classification, decision));
  return 0;
}

function runAudit(args: string[], io: CliIo): number {
  const [subcommand, ...rest] = args;

  if (subcommand !== "tail") {
    io.stderr("Usage: warden audit tail [--path .warden/audit.jsonl] [--limit 20] [--json]\n");
    return 1;
  }

  const options = parseOptions(rest);
  const auditPath = resolve(io.cwd, options.value("--path") ?? ".warden/audit.jsonl");
  const limit = Number(options.value("--limit") ?? "20");

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("--limit must be a positive integer.");
  }

  if (!existsSync(auditPath)) {
    io.stdout(`No audit log found at ${auditPath}\n`);
    return 0;
  }

  const events = readAuditEvents(auditPath).slice(-limit);
  if (options.has("--json")) {
    io.stdout(`${JSON.stringify(events, null, 2)}\n`);
    return 0;
  }

  for (const event of events) {
    io.stdout(
      `${event.timestamp} ${event.decision} ${event.tool} risks=${event.riskLabels.join(",")} rule=${event.policyRule}\n`,
    );
  }

  return 0;
}

async function runLogin(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args);
  const token = options.value("--token") ?? process.env["WARDEN_TELEGRAM_TOKEN"];
  if (!token) {
    io.stderr(
      "Usage: warden login --token <bot-token>   (create a bot with @BotFather)\n",
    );
    return 1;
  }

  const credentialsPath = options.value("--credentials");
  const timeoutRaw = Number(options.value("--timeout") ?? "300");
  const timeoutSeconds = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 300;

  const clientOptions: TelegramClientOptions = { token };
  const apiBaseUrl = options.value("--api-base-url");
  if (apiBaseUrl) {
    clientOptions.apiBaseUrl = apiBaseUrl;
  }
  const client = new TelegramClient(clientOptions);

  let username: string;
  try {
    username = (await client.getMe()).username ?? "your_bot";
  } catch (error) {
    io.stderr(
      `Could not reach Telegram with that token: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  const code = randomBytes(4).toString("hex");
  io.stdout(
    `Open this link on the device that should approve actions, then tap Start:\n\n  https://t.me/${username}?start=${code}\n\nWaiting for the bot to be started...\n`,
  );

  const chatId = await waitForPairing(client, code, timeoutSeconds);
  if (chatId === undefined) {
    io.stderr("Timed out waiting for the bot to be started. Run `warden login` again.\n");
    return 1;
  }

  await client.sendMessage(
    chatId,
    "✅ Warden is now linked to this device. You'll receive approval polls here.",
  );

  const credentials: TelegramCredentials = { token, chatId };
  if (username !== "your_bot") {
    credentials.botUsername = username;
  }
  saveTelegramCredentials(credentials, credentialsPath);

  io.stdout(
    `Linked. Approver chat id ${chatId} saved to ${credentialsPath ?? defaultTelegramCredentialsPath()}.\nSet "approval.method: telegram" in your warden.yaml to use it.\n`,
  );
  return 0;
}

async function waitForPairing(
  client: TelegramClient,
  code: string,
  timeoutSeconds: number,
): Promise<number | undefined> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let offset: number | undefined;

  while (Date.now() < deadline) {
    let updates;
    try {
      updates = await client.getUpdates({ offset, timeoutSeconds: 5 });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      if (update.message?.text?.trim() === `/start ${code}`) {
        return update.message.chat.id;
      }
    }
  }

  return undefined;
}

function loadConfig(path: string, explicit: boolean) {
  if (existsSync(path)) {
    return loadPolicyConfig(path);
  }

  if (explicit) {
    throw new Error(`Policy config not found: ${path}`);
  }

  return defaultPolicyConfig();
}

function formatPolicyTest(
  tool: string,
  classification: { labels: string[]; reasons: string[] },
  decision: { decision: string; rule: string; reason: string },
): string {
  const lines = [
    `tool: ${tool}`,
    `decision: ${decision.decision}`,
    `risks: ${classification.labels.join(",")}`,
    `rule: ${decision.rule}`,
    `reason: ${decision.reason}`,
  ];

  for (const reason of classification.reasons) {
    lines.push(`classifier: ${reason}`);
  }

  return `${lines.join("\n")}\n`;
}

function parseOptions(args: string[]): {
  positionals: string[];
  has: (name: string) => boolean;
  value: (name: string) => string | undefined;
} {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(arg, next);
      index += 1;
    } else {
      flags.add(arg);
    }
  }

  return {
    positionals,
    has: (name) => flags.has(name) || values.has(name),
    value: (name) => values.get(name),
  };
}

function helpText(): string {
  return `Warden — a guardrail for OpenAI Agents SDK apps

Commands:
  warden init [--path warden.yaml] [--agent agent.ts] [--policy-only] [--force]
              [--approval-method ${APPROVAL_METHODS.join("|")}] [--approval-timeout ${TIMEOUT_PRESET_NAMES.join("|")}]
              # scaffold a runnable guarded agent; --policy-only writes just warden.yaml
  warden policy test <call.json> [--config warden.yaml] [--json] [--audit]
  warden audit tail [--path .warden/audit.jsonl] [--limit 20] [--json]
  warden login --token <bot-token>             # link a Telegram approver device
`;
}
