import { readFileSync } from "node:fs";
import { parseToolRef } from "../domain/tool-ref.js";
import type { JsonObject, ToolCall, ToolMetadata } from "../domain/types.js";

export function loadToolCallFixture(path: string): ToolCall {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return normalizeToolCallFixture(parsed, path);
}

export function normalizeToolCallFixture(value: unknown, path = "tool call"): ToolCall {
  const object = expectObject(value, path);
  const tool = object["tool"];

  if (typeof tool !== "string" || !tool.trim()) {
    throw new Error(`${path}.tool must be a non-empty string.`);
  }

  const ref = parseToolRef(tool);
  const args = object["arguments"] ?? {};
  const argumentsObject = expectObject(args, `${path}.arguments`);
  const metadata: ToolMetadata = {
    ref,
    description:
      typeof object["description"] === "string" ? object["description"] : "",
    inputSchema:
      object["inputSchema"] === undefined
        ? {}
        : expectObject(object["inputSchema"], `${path}.inputSchema`),
    annotations:
      object["annotations"] === undefined
        ? {}
        : expectObject(object["annotations"], `${path}.annotations`),
  };

  const call: ToolCall = {
    ref,
    arguments: argumentsObject,
    metadata,
  };

  assignString(call, "runId", object["runId"], `${path}.runId`);
  assignString(call, "callId", object["callId"], `${path}.callId`);
  assignString(call, "client", object["client"], `${path}.client`);
  assignString(call, "agent", object["agent"], `${path}.agent`);
  assignString(call, "user", object["user"], `${path}.user`);

  return call;
}

function assignString<T extends keyof ToolCall>(
  call: ToolCall,
  key: T,
  value: unknown,
  path: string,
): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string.`);
  }

  call[key] = value as ToolCall[T];
}

function expectObject(value: unknown, path: string): JsonObject {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${path} must be an object.`);
  }

  return value as JsonObject;
}
