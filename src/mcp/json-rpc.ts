import type { JsonObject, JsonValue } from "../domain/types.js";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: JsonValue;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: JsonValue;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: JsonValue;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse;

export const JSON_RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export function parseJsonRpcLine(line: string): JsonRpcMessage {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    throw new JsonRpcProtocolError(
      JSON_RPC_ERROR.parseError,
      "Invalid JSON-RPC JSON.",
      null,
    );
  }

  return normalizeJsonRpcMessage(parsed);
}

export function normalizeJsonRpcMessage(value: unknown): JsonRpcMessage {
  if (!isJsonObject(value) || value["jsonrpc"] !== "2.0") {
    throw new JsonRpcProtocolError(
      JSON_RPC_ERROR.invalidRequest,
      "JSON-RPC message must be an object with jsonrpc=\"2.0\".",
      extractId(value),
    );
  }

  if (typeof value["method"] === "string") {
    return normalizeRequest(value);
  }

  if ("result" in value || "error" in value) {
    return normalizeResponse(value);
  }

  throw new JsonRpcProtocolError(
    JSON_RPC_ERROR.invalidRequest,
    "JSON-RPC message must be a request, notification, or response.",
    extractId(value),
  );
}

export function successResponse(id: JsonRpcId, result: JsonValue): JsonRpcSuccess {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

export function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: JsonValue,
): JsonRpcFailure {
  const error: JsonRpcFailure["error"] = {
    code,
    message,
  };

  if (data !== undefined) {
    error.data = data;
  }

  return {
    jsonrpc: "2.0",
    id,
    error,
  };
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message;
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return "result" in message || "error" in message;
}

export class JsonRpcProtocolError extends Error {
  readonly code: number;
  readonly id: JsonRpcId;
  readonly data?: JsonValue;

  constructor(code: number, message: string, id: JsonRpcId, data?: JsonValue) {
    super(message);
    this.name = "JsonRpcProtocolError";
    this.code = code;
    this.id = id;
    if (data !== undefined) {
      this.data = data;
    }
  }
}

function normalizeRequest(value: JsonObject): JsonRpcRequest {
  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    method: value["method"] as string,
  };

  if ("id" in value) {
    request.id = normalizeId(value["id"]);
  }

  if ("params" in value) {
    request.params = value["params"];
  }

  return request;
}

function normalizeResponse(value: JsonObject): JsonRpcResponse {
  if (!("id" in value)) {
    throw new JsonRpcProtocolError(
      JSON_RPC_ERROR.invalidRequest,
      "JSON-RPC response must include an id.",
      null,
    );
  }

  const id = normalizeId(value["id"]);

  if ("error" in value) {
    const rawError = value["error"];
    if (
      !isJsonObject(rawError) ||
      typeof rawError["code"] !== "number" ||
      typeof rawError["message"] !== "string"
    ) {
      throw new JsonRpcProtocolError(
        JSON_RPC_ERROR.invalidRequest,
        "JSON-RPC error response is malformed.",
        id,
      );
    }

    return errorResponse(id, rawError["code"], rawError["message"], rawError["data"]);
  }

  if (!("result" in value)) {
    throw new JsonRpcProtocolError(
      JSON_RPC_ERROR.invalidRequest,
      "JSON-RPC success response must include result.",
      id,
    );
  }

  return successResponse(id, value["result"]);
}

function normalizeId(value: JsonValue | undefined): JsonRpcId {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    value === null
  ) {
    return value;
  }

  throw new JsonRpcProtocolError(
    JSON_RPC_ERROR.invalidRequest,
    "JSON-RPC id must be a string, number, or null.",
    null,
  );
}

function extractId(value: unknown): JsonRpcId {
  if (!isJsonObject(value) || !("id" in value)) {
    return null;
  }

  const id = value["id"];
  if (typeof id === "string" || typeof id === "number" || id === null) {
    return id;
  }

  return null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
