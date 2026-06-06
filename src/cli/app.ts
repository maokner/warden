import { spawn } from "node:child_process";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { AddressInfo } from "node:net";
import type { ApprovalReviewer } from "../approval/approval.js";
import { createTerminalReviewer } from "../approval/terminal.js";
import type {
  Classification,
  JsonObject,
  PolicyDecision,
  ToolMetadata,
} from "../domain/types.js";
import {
  appendAuditEvent,
  classifyToolCall,
  createAuditEvent,
  defaultPolicyConfig,
  evaluatePolicy,
  hashPolicyConfig,
  loadPolicyConfig,
  loadToolCallFixture,
  makeToolRef,
  readAuditEvents,
  runDoctor,
} from "../index.js";
import {
  policyTemplate,
  policyTemplateNames,
} from "../config/sample-policy.js";
import { createScrubbedExecEnvironment } from "../exec/environment.js";
import { createHttpDecisionServer } from "../http/sidecar.js";
import { McpGateway } from "../mcp/gateway.js";
import { LineJsonRpcPeer } from "../mcp/line-json-rpc.js";
import { createStdioUpstreams } from "../mcp/upstream.js";
import {
  DEFAULT_APPROVAL_HOST,
  DEFAULT_APPROVAL_PORT,
} from "../approval/server.js";
import { parseTimeout, TIMEOUT_PRESET_NAMES } from "../approval/methods.js";
import { APPROVAL_METHODS } from "../domain/types.js";
import type { PendingApprovalView } from "../approval/queue.js";
import { randomBytes } from "node:crypto";
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
  mcpInput?: Readable;
  mcpOutput?: Writable;
  approvalInput?: Readable;
  approvalOutput?: Writable;
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
      case "approvals":
        return await runApprovals(rest, io);
      case "approve":
        return await runApprovalDecision("approve", rest, io);
      case "deny":
        return await runApprovalDecision("reject", rest, io);
      case "doctor":
        return runDoctorCommand(rest, io);
      case "inspect":
        return await runInspect(rest, io);
      case "setup":
        return runSetup(rest, io);
      case "login":
        return await runLogin(rest, io);
      case "serve":
        return await runServe(rest, io);
      case "proxy":
        return await runProxy(rest, io);
      case "exec":
        return await runExec(rest, io);
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
  const outputPath = resolve(io.cwd, options.value("--path") ?? "warden.yaml");
  const templateName = options.value("--template") ?? "default";
  const force = options.has("--force");

  if (existsSync(outputPath) && !force) {
    io.stderr(
      `${outputPath} already exists. Use --force to overwrite it intentionally.\n`,
    );
    return 1;
  }

  const template = applyApprovalOverrides(
    policyTemplate(templateName),
    options.value("--approval-method"),
    options.value("--approval-timeout"),
  );

  writeFileSync(outputPath, template);
  io.stdout(`Created ${outputPath} from ${templateName} template\n`);
  return 0;
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
    result = result.replace(/method: \w+/, `method: ${method}`);
  }

  if (timeout !== undefined) {
    parseTimeout(timeout); // validates preset name or seconds, throws otherwise
    result = result.replace(/timeout: \S+/, `timeout: ${timeout}`);
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

async function runApprovals(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args);
  const baseUrl = approvalBaseUrl(options);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/approvals`);
  } catch {
    io.stderr(approvalUnreachable(baseUrl));
    return 1;
  }

  if (!response.ok) {
    io.stderr(`Approval inbox returned HTTP ${response.status}.\n`);
    return 1;
  }

  const body = (await response.json()) as { approvals: PendingApprovalView[] };
  const approvals = body.approvals ?? [];

  if (options.has("--json")) {
    io.stdout(`${JSON.stringify(approvals, null, 2)}\n`);
    return 0;
  }

  if (approvals.length === 0) {
    io.stdout("No pending approvals.\n");
    return 0;
  }

  for (const approval of approvals) {
    io.stdout(
      `${approval.id} ${approval.tool} risks=${approval.riskLabels.join(",")} expires=${approval.expiresAt}\n`,
    );
  }

  return 0;
}

async function runApprovalDecision(
  action: "approve" | "reject",
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  const id = options.positionals[0];
  const command = action === "approve" ? "approve" : "deny";

  if (!id) {
    io.stderr(
      `Usage: warden ${command} <id> [--url http://127.0.0.1:${DEFAULT_APPROVAL_PORT}] [--reason ...] [--approver ...]\n`,
    );
    return 1;
  }

  const baseUrl = approvalBaseUrl(options);
  const body: JsonObject = {};
  const reason = options.value("--reason");
  const approver = options.value("--approver");
  if (reason) {
    body["reason"] = reason;
  }
  if (approver) {
    body["approver"] = approver;
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/approvals/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    io.stderr(approvalUnreachable(baseUrl));
    return 1;
  }

  if (response.status === 404) {
    io.stderr(`No pending approval with id ${id} (it may have expired).\n`);
    return 1;
  }

  if (!response.ok) {
    io.stderr(`Approval inbox returned HTTP ${response.status}.\n`);
    return 1;
  }

  io.stdout(`${action === "approve" ? "Approved" : "Denied"} ${id}\n`);
  return 0;
}

function approvalBaseUrl(options: { value: (name: string) => string | undefined }): string {
  return (
    options.value("--url") ??
    `http://${DEFAULT_APPROVAL_HOST}:${DEFAULT_APPROVAL_PORT}`
  );
}

function approvalUnreachable(baseUrl: string): string {
  return `Could not reach the Warden approval inbox at ${baseUrl}. Start an app configured with approval method "local" (or run "warden serve").\n`;
}

function runDoctorCommand(args: string[], io: CliIo): number {
  const options = parseOptions(args);
  const configPath = resolve(io.cwd, options.value("--config") ?? "warden.yaml");
  let auditPath: string | undefined;
  let policyPath: string | undefined;

  if (existsSync(configPath)) {
    const config = loadPolicyConfig(configPath);
    policyPath = configPath;
    auditPath = resolve(io.cwd, config.auditPath);
  } else if (options.has("--config")) {
    throw new Error(`Policy config not found: ${configPath}`);
  }

  const doctorOptions = {
    env: process.env,
  };
  if (process.env["HOME"]) {
    Object.assign(doctorOptions, { homeDir: process.env["HOME"] });
  }
  if (policyPath) {
    Object.assign(doctorOptions, { policyPath });
  }
  if (auditPath) {
    Object.assign(doctorOptions, { auditPath });
  }
  const report = runDoctor(io.cwd, doctorOptions);

  if (options.has("--json")) {
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    return report.status === "monitoring_only" ? 2 : 0;
  }

  io.stdout(`status: ${report.status}\n`);
  for (const issue of report.issues) {
    io.stdout(`${issue.severity}: ${issue.code} - ${issue.message}\n`);
  }

  return report.status === "monitoring_only" ? 2 : 0;
}

async function runExec(args: string[], io: CliIo): Promise<number> {
  const parsed = parseExecArgs(args);
  if (parsed.command.length === 0) {
    io.stderr("Usage: warden exec [--config warden.yaml] -- <command> [args...]\n");
    return 1;
  }

  const configPath = resolve(io.cwd, parsed.configPath);
  if (!existsSync(configPath)) {
    io.stderr(`Policy config not found: ${configPath}\n`);
    return 1;
  }

  const sandbox = createScrubbedExecEnvironment({
    cwd: io.cwd,
    configPath,
    env: process.env,
  });

  io.stderr(
    `Warden exec launching with scrubbed HOME=${sandbox.homeDir} and CODEX_HOME=${sandbox.codexHome}\n`,
  );

  try {
    return await spawnExecCommand(parsed.command, io, sandbox.env);
  } finally {
    sandbox.cleanup();
  }
}

function runSetup(args: string[], io: CliIo): number {
  const [target, ...rest] = args;
  const options = parseOptions(rest);
  const configPath = resolve(io.cwd, options.value("--config") ?? "warden.yaml");

  switch (target) {
    case "codex":
      io.stdout(codexSetupSnippet(configPath));
      return 0;
    case "claude":
      io.stdout(claudeSetupSnippet(configPath));
      return 0;
    default:
      io.stderr("Usage: warden setup codex|claude [--config /path/to/warden.yaml]\n");
      return 1;
  }
}

interface InspectToolEntry {
  name: string;
  upstream: string;
  upstreamTool: string;
  description: string;
  riskLabels: string[];
  riskReasons: string[];
  decision: string;
  policyRule: string;
  policyReason: string;
  inputSchema: JsonObject;
  annotations: JsonObject;
}

async function runInspect(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args);
  const configPath = options.value("--config") ?? "warden.yaml";
  const config = loadConfig(resolve(io.cwd, configPath), options.has("--config"));
  const upstreams = createStdioUpstreams(config.upstreams);

  if (upstreams.length === 0) {
    io.stderr("warden inspect requires at least one configured upstream.\n");
    return 1;
  }

  try {
    await Promise.all(upstreams.map((upstream) => upstream.initialize()));
    const tools: InspectToolEntry[] = [];

    for (const upstream of upstreams) {
      const upstreamTools = await upstream.listTools();
      for (const upstreamTool of upstreamTools) {
        const ref = makeToolRef(upstream.name, upstreamTool.name);
        const metadata: ToolMetadata = {
          ref,
          description: upstreamTool.description ?? "",
          inputSchema: upstreamTool.inputSchema,
          annotations: upstreamTool.annotations ?? {},
        };
        const classification = classifyToolCall(metadata, {});
        const decision = evaluatePolicy(config, ref.fullName, classification);
        tools.push(inspectToolEntry(metadata, classification, decision));
      }
    }

    tools.sort((left, right) => left.name.localeCompare(right.name));

    if (options.has("--json")) {
      io.stdout(`${JSON.stringify({ tools }, null, 2)}\n`);
      return 0;
    }

    io.stdout(formatInspectTools(tools));
    return 0;
  } finally {
    for (const upstream of upstreams) {
      upstream.close();
    }
  }
}

function inspectToolEntry(
  metadata: ToolMetadata,
  classification: Classification,
  decision: PolicyDecision,
): InspectToolEntry {
  return {
    name: metadata.ref.fullName,
    upstream: metadata.ref.upstream,
    upstreamTool: metadata.ref.name,
    description: metadata.description,
    riskLabels: classification.labels,
    riskReasons: classification.reasons,
    decision: decision.decision,
    policyRule: decision.rule,
    policyReason: decision.reason,
    inputSchema: metadata.inputSchema,
    annotations: metadata.annotations,
  };
}

function formatInspectTools(tools: InspectToolEntry[]): string {
  const lines: string[] = [];

  for (const tool of tools) {
    lines.push(tool.name);
    lines.push(`  upstream: ${tool.upstream}`);
    lines.push(`  upstream_tool: ${tool.upstreamTool}`);
    lines.push(`  decision: ${tool.decision}`);
    lines.push(`  risks: ${tool.riskLabels.join(",")}`);
    lines.push(`  rule: ${tool.policyRule}`);
    lines.push(`  reason: ${tool.policyReason}`);
    if (tool.description) {
      lines.push(`  description: ${tool.description}`);
    }
    for (const reason of tool.riskReasons) {
      lines.push(`  classifier: ${reason}`);
    }
    lines.push("");
  }

  return tools.length === 0
    ? "No tools discovered.\n"
    : `${lines.join("\n")}`;
}

async function runProxy(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args);
  const configPath = options.value("--config") ?? "warden.yaml";
  const config = loadConfig(resolve(io.cwd, configPath), options.has("--config"));
  const upstreams = createStdioUpstreams(config.upstreams);

  if (upstreams.length === 0) {
    io.stderr("warden proxy requires at least one configured upstream.\n");
    return 1;
  }

  const approvalOptions = {
    approver: options.value("--approver") ?? defaultApprover(),
  };
  if (io.approvalInput) {
    Object.assign(approvalOptions, { input: io.approvalInput });
  }
  if (io.approvalOutput) {
    Object.assign(approvalOptions, { output: io.approvalOutput });
  }
  const approvalSideChannel = createApprovalSideChannel(approvalOptions);

  const gatewayOptions = {
    config,
    upstreams,
    auditPath: resolve(io.cwd, config.auditPath),
  };
  if (approvalSideChannel.reviewer) {
    Object.assign(gatewayOptions, { reviewer: approvalSideChannel.reviewer });
  }
  const gateway = new McpGateway(gatewayOptions);

  io.stderr(`Warden proxy started with ${upstreams.length} upstream(s).\n`);
  io.stderr(`${approvalSideChannel.message}\n`);

  return new Promise<number>((resolveExitCode) => {
    const input = io.mcpInput ?? process.stdin;
    const output = io.mcpOutput ?? process.stdout;
    const peer = new LineJsonRpcPeer({
      input,
      output,
      onRequest: (request) => gateway.handleRequest(request),
      onNotification: () => undefined,
      onError: (error) => {
        io.stderr(`${error.message}\n`);
      },
    });

    let closed = false;
    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      peer.close();
      gateway.close();
      approvalSideChannel.close();
      resolveExitCode(0);
    };

    input.once("close", close);
    input.once("end", close);
  });
}

async function runServe(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args);
  const configPath = options.value("--config") ?? "warden.yaml";
  const config = loadConfig(resolve(io.cwd, configPath), options.has("--config"));
  const host = options.value("--host") ?? "127.0.0.1";
  const port = parsePort(options.value("--port") ?? "8787");
  const server = createHttpDecisionServer({
    config,
    auditPath: resolve(io.cwd, config.auditPath),
  });

  return new Promise<number>((resolveExitCode, reject) => {
    let listening = false;

    server.once("error", (error) => {
      if (!listening) {
        reject(error);
      } else {
        io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
      }
    });

    server.once("close", () => {
      resolveExitCode(0);
    });

    server.listen(port, host, () => {
      listening = true;
      const address = server.address();
      const actualPort =
        typeof address === "object" && address !== null
          ? (address as AddressInfo).port
          : port;
      io.stderr(
        `Warden HTTP sidecar listening on http://${host}:${actualPort}\n`,
      );
    });
  });
}

function createApprovalSideChannel(options: {
  input?: Readable;
  output?: Writable;
  approver: string;
}): {
  reviewer?: ApprovalReviewer;
  close: () => void;
  message: string;
} {
  if (options.input || options.output) {
    if (!options.input || !options.output) {
      throw new Error("Proxy approval side channel requires both input and output streams.");
    }

    return {
      reviewer: createTerminalReviewer({
        input: options.input,
        output: options.output,
        approver: options.approver,
      }),
      close: () => undefined,
      message: "Approval side channel: injected terminal streams.",
    };
  }

  let inputFd: number | undefined;
  let outputFd: number | undefined;

  try {
    inputFd = openSync("/dev/tty", "r");
    outputFd = openSync("/dev/tty", "w");
    const input = createReadStream("/dev/tty", {
      fd: inputFd,
      autoClose: true,
    });
    const output = createWriteStream("/dev/tty", {
      fd: outputFd,
      autoClose: true,
    });

    return {
      reviewer: createTerminalReviewer({
        input,
        output,
        approver: options.approver,
      }),
      close: () => {
        input.destroy();
        output.destroy();
      },
      message: "Approval side channel: /dev/tty terminal prompt.",
    };
  } catch {
    if (inputFd !== undefined) {
      closeSync(inputFd);
    }
    if (outputFd !== undefined) {
      closeSync(outputFd);
    }

    return {
      close: () => undefined,
      message:
        "Approval side channel unavailable; approval-required calls will fail closed.",
    };
  }
}

function defaultApprover(): string {
  return process.env["USER"] ?? process.env["USERNAME"] ?? "local_user";
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

function parseExecArgs(args: string[]): {
  configPath: string;
  command: string[];
} {
  let configPath = "warden.yaml";
  const command: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }

    if (arg === "--") {
      command.push(...args.slice(index + 1));
      break;
    }

    if (arg === "--config") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--config requires a path.");
      }
      configPath = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown warden exec option: ${arg}`);
    }

    command.push(...args.slice(index));
    break;
  }

  return { configPath, command };
}

function spawnExecCommand(
  command: string[],
  io: CliIo,
  env: Record<string, string>,
): Promise<number> {
  return new Promise((resolveExitCode, reject) => {
    const child = spawn(command[0] as string, command.slice(1), {
      cwd: io.cwd,
      env,
      stdio: ["inherit", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      io.stdout(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      io.stderr(String(chunk));
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (typeof code === "number") {
        resolveExitCode(code);
        return;
      }

      io.stderr(`Command exited from signal ${signal ?? "unknown"}\n`);
      resolveExitCode(1);
    });
  });
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port must be an integer between 0 and 65535.");
  }

  return port;
}

function helpText(): string {
  return `Warden

Commands:
  warden init [--path warden.yaml] [--template ${policyTemplateNames().join("|")}] [--force]
              [--approval-method ${APPROVAL_METHODS.join("|")}] [--approval-timeout ${TIMEOUT_PRESET_NAMES.join("|")}]
  warden policy test <call.json> [--config warden.yaml] [--json] [--audit]
  warden audit tail [--path .warden/audit.jsonl] [--limit 20] [--json]
  warden approvals [--url http://127.0.0.1:${DEFAULT_APPROVAL_PORT}] [--json]
  warden approve <id> [--url ...] [--reason ...] [--approver ...]
  warden deny <id> [--url ...] [--reason ...]
  warden doctor [--config warden.yaml] [--json]
  warden inspect --config warden.yaml [--json]
  warden setup codex|claude [--config /path/to/warden.yaml]
  warden login --token <bot-token>             # link a Telegram approver device
  warden serve [--config warden.yaml] [--host 127.0.0.1] [--port 8787]
  warden proxy --config warden.yaml [--approver local_user]
  warden exec [--config warden.yaml] -- <command> [args...]
`;
}

function codexSetupSnippet(configPath: string): string {
  return `[mcp_servers.warden]
command = "warden"
args = ["proxy", "--config", "${escapeTomlString(configPath)}"]
default_tools_approval_mode = "approve"

# Keep protected upstream MCP servers out of Codex config.
# Warden should own upstream credentials, policy, approval, and audit.
`;
}

function claudeSetupSnippet(configPath: string): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        warden: {
          type: "stdio",
          command: "warden",
          args: ["proxy", "--config", configPath],
        },
      },
    },
    null,
    2,
  )}
`;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
