import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonObject } from "../domain/types.js";

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, message: string, code?: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code ?? defaultCode(statusCode);
  }
}

function defaultCode(statusCode: number): string {
  if (statusCode === 413) return "payload_too_large";
  if (statusCode === 404) return "not_found";
  return "bad_request";
}

export async function readJsonBody(
  request: IncomingMessage,
  options: { maxBytes: number; allowEmpty?: boolean },
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    totalBytes += buffer.length;
    if (totalBytes > options.maxBytes) {
      throw new HttpError(413, "Request body is too large.");
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  if (!body.trim()) {
    if (options.allowEmpty) {
      return undefined;
    }
    throw new HttpError(400, "Request body is required.");
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

export function writeJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

export function writeHtml(
  response: ServerResponse,
  statusCode: number,
  html: string,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(html);
}

export function writeError(response: ServerResponse, error: unknown): void {
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

export function expectObject(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, `${path} must be an object.`);
  }

  return value as JsonObject;
}

export function assignIfPresent<T extends object, K extends string, V>(
  target: T,
  key: K,
  value: V | undefined,
): asserts target is T & Record<K, V> {
  if (value !== undefined) {
    Object.assign(target, { [key]: value });
  }
}
