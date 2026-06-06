import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendAuditEvent, createAuditEvent } from "../audit/logger.js";
import { classifyToolCall } from "../classify/classifier.js";
import type {
  AuditEvent,
  Classification,
  JsonObject,
  JsonValue,
  PolicyConfig,
  PolicyDecision,
  ToolCall,
  ToolMetadata,
} from "../domain/types.js";
import { parseToolRef } from "../domain/tool-ref.js";
import { evaluatePolicy } from "../policy/engine.js";
import { hashPolicyConfig } from "../policy/hash.js";
import { redactArguments } from "../policy/redaction.js";

export interface HttpDecisionRequest {
  tool: string;
  arguments?: JsonObject;
  description?: string;
  inputSchema?: JsonObject;
  annotations?: JsonObject;
  runId?: string;
  callId?: string;
  client?: string;
  agent?: string;
  user?: string;
}

export interface HttpDecisionResponse {
  status: "allowed" | "denied" | "requires_approval" | "unsupported";
  allowed: boolean;
  requiresApproval: boolean;
  classification: Classification;
  decision: PolicyDecision;
  policyVersion: string;
  auditEvent: AuditEvent;
  forwardArguments?: JsonObject;
  error?: string;
}

export interface CreateHttpDecisionServerOptions {
  config: PolicyConfig;
  auditPath?: string;
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export function createHttpDecisionServer(
  options: CreateHttpDecisionServerOptions,
) {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return createServer((request, response) => {
    void handleHttpRequest(request, response, options, maxBodyBytes).catch(
      (error) => {
        writeError(response, error);
      },
    );
  });
}

export function decideHttpAction(input: {
  config: PolicyConfig;
  request: HttpDecisionRequest;
  auditPath?: string | undefined;
}): HttpDecisionResponse {
  const ref = parseToolRef(input.request.tool);
  const metadata: ToolMetadata = {
    ref,
    description: input.request.description ?? "",
    inputSchema: input.request.inputSchema ?? {},
    annotations: input.request.annotations ?? {},
  };
  const call: ToolCall = {
    ref,
    metadata,
    arguments: input.request.arguments ?? {},
  };

  assignIfPresent(call, "runId", input.request.runId);
  assignIfPresent(call, "callId", input.request.callId);
  assignIfPresent(call, "client", input.request.client);
  assignIfPresent(call, "agent", input.request.agent);
  assignIfPresent(call, "user", input.request.user);

  const classification = classifyToolCall(metadata, call.arguments);
  const decision = evaluatePolicy(input.config, ref.fullName, classification);
  const policyVersion = hashPolicyConfig(input.config);
  const responseBase = {
    classification,
    decision,
    policyVersion,
  };

  if (decision.decision === "deny") {
    return finalizeDecision({
      ...responseBase,
      config: input.config,
      call,
      auditPath: input.auditPath,
      status: "denied",
      allowed: false,
      requiresApproval: false,
      error: "Tool call denied by policy.",
    });
  }

  if (decision.decision === "require_approval") {
    return finalizeDecision({
      ...responseBase,
      config: input.config,
      call,
      auditPath: input.auditPath,
      status: "requires_approval",
      allowed: false,
      requiresApproval: true,
      error: "Approval required before this action can execute.",
    });
  }

  if (decision.decision === "transform_then_allow") {
    return finalizeDecision({
      ...responseBase,
      config: input.config,
      call,
      auditPath: input.auditPath,
      status: "unsupported",
      allowed: false,
      requiresApproval: false,
      error:
        "transform_then_allow is not implemented; refusing to return original arguments.",
    });
  }

  const forwardArguments =
    decision.decision === "redact_then_allow"
      ? redactArguments(call.arguments, input.config.redaction.fields).value
      : structuredClone(call.arguments);

  return finalizeDecision({
    ...responseBase,
    config: input.config,
    call,
    auditPath: input.auditPath,
    status: "allowed",
    allowed: true,
    requiresApproval: false,
    forwardArguments,
  });
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: CreateHttpDecisionServerOptions,
  maxBodyBytes: number,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, { status: "ok" });
    return;
  }

  if (url.pathname !== "/v1/decide") {
    writeJson(response, 404, { error: "not_found" });
    return;
  }

  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  const rawBody = await readJsonBody(request, maxBodyBytes);
  const decisionRequest = normalizeDecisionRequest(rawBody);
  const result = decideHttpAction({
    config: options.config,
    request: decisionRequest,
    auditPath: options.auditPath,
  });

  writeJson(response, 200, result);
}

function finalizeDecision(args: {
  config: PolicyConfig;
  call: ToolCall;
  classification: Classification;
  decision: PolicyDecision;
  policyVersion: string;
  status: HttpDecisionResponse["status"];
  allowed: boolean;
  requiresApproval: boolean;
  auditPath?: string | undefined;
  forwardArguments?: JsonObject | undefined;
  error?: string | undefined;
}): HttpDecisionResponse {
  const auditInput = {
    call: args.call,
    decision: args.decision,
    policyVersion: args.policyVersion,
    redactionFields: args.config.redaction.fields,
    responseStatus: "not_executed" as const,
    responseSummary: `HTTP decision sidecar returned ${args.status}.`,
  };

  assignIfPresent(auditInput, "error", args.error);

  const auditEvent = createAuditEvent(auditInput);
  if (args.auditPath) {
    appendAuditEvent(args.auditPath, auditEvent);
  }

  const response: HttpDecisionResponse = {
    status: args.status,
    allowed: args.allowed,
    requiresApproval: args.requiresApproval,
    classification: args.classification,
    decision: args.decision,
    policyVersion: args.policyVersion,
    auditEvent,
  };

  assignIfPresent(response, "forwardArguments", args.forwardArguments);
  assignIfPresent(response, "error", args.error);
  return response;
}

async function readJsonBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    totalBytes += buffer.length;
    if (totalBytes > maxBodyBytes) {
      throw new HttpError(413, "Request body is too large.");
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  if (!body.trim()) {
    throw new HttpError(400, "Request body is required.");
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function normalizeDecisionRequest(value: unknown): HttpDecisionRequest {
  const object = expectObject(value, "request body");
  const tool = object["tool"];
  if (typeof tool !== "string" || !tool.trim()) {
    throw new HttpError(400, "request body.tool must be a non-empty string.");
  }
  try {
    parseToolRef(tool);
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : "request body.tool is invalid.",
    );
  }

  const request: HttpDecisionRequest = {
    tool,
    arguments: normalizeOptionalObject(object["arguments"], "request body.arguments") ?? {},
  };

  assignIfPresent(
    request,
    "description",
    normalizeOptionalString(object["description"], "request body.description"),
  );
  assignIfPresent(
    request,
    "inputSchema",
    normalizeOptionalObject(object["inputSchema"], "request body.inputSchema"),
  );
  assignIfPresent(
    request,
    "annotations",
    normalizeOptionalObject(object["annotations"], "request body.annotations"),
  );
  assignIfPresent(
    request,
    "runId",
    normalizeOptionalString(object["runId"], "request body.runId"),
  );
  assignIfPresent(
    request,
    "callId",
    normalizeOptionalString(object["callId"], "request body.callId"),
  );
  assignIfPresent(
    request,
    "client",
    normalizeOptionalString(object["client"], "request body.client"),
  );
  assignIfPresent(
    request,
    "agent",
    normalizeOptionalString(object["agent"], "request body.agent"),
  );
  assignIfPresent(
    request,
    "user",
    normalizeOptionalString(object["user"], "request body.user"),
  );

  return request;
}

function normalizeOptionalObject(
  value: JsonValue | undefined,
  path: string,
): JsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectObject(value, path);
}

function normalizeOptionalString(
  value: JsonValue | undefined,
  path: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${path} must be a non-empty string.`);
  }

  return value;
}

function expectObject(value: unknown, path: string): JsonObject {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new HttpError(400, `${path} must be an object.`);
  }

  return value as JsonObject;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function writeError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }

  if (error instanceof HttpError) {
    writeJson(response, error.statusCode, {
      error: error.code,
      message: error.message,
    });
    return;
  }

  writeJson(response, 500, {
    error: "internal_error",
    message: error instanceof Error ? error.message : String(error),
  });
}

class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = statusCode === 413 ? "payload_too_large" : "bad_request";
  }
}

function assignIfPresent<T extends object, K extends string, V>(
  target: T,
  key: K,
  value: V | undefined,
): asserts target is T & Record<K, V> {
  if (value !== undefined) {
    Object.assign(target, { [key]: value });
  }
}
