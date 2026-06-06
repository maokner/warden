import type { ApprovalReviewer } from "../approval/approval.js";
import type {
  JsonObject,
  JsonValue,
  PolicyConfig,
  ToolCall,
  ToolMetadata,
} from "../domain/types.js";
import { parseToolRef } from "../domain/tool-ref.js";
import {
  handleToolCall,
  type HandleToolCallResult,
  type ToolExecutor,
} from "../pipeline/handle-tool-call.js";
import { peekWardenRuntime } from "./runtime.js";

export interface GuardActionInput {
  tool: string;
  arguments: JsonObject;
  execute: (args: JsonObject) => Promise<JsonValue> | JsonValue;
  config?: PolicyConfig;
  description?: string;
  inputSchema?: JsonObject;
  annotations?: JsonObject;
  reviewer?: ApprovalReviewer;
  auditPath?: string;
  runId?: string;
  callId?: string;
  client?: string;
  agent?: string;
  user?: string;
  summarizeOutput?: (output: JsonValue) => string;
  /** Upstream used to namespace a bare tool name. Defaults to "app". */
  defaultUpstream?: string;
}

export type GuardActionResult = HandleToolCallResult;

export async function guardAction(
  input: GuardActionInput,
): Promise<GuardActionResult> {
  const runtime = peekWardenRuntime();
  const config = input.config ?? runtime?.config;
  if (!config) {
    throw new Error(
      "Warden has no policy config. Pass `config` or call configureWarden() first.",
    );
  }

  const ref = parseToolRef(
    ensureNamespaced(input.tool, input.defaultUpstream ?? "app"),
  );
  const metadata: ToolMetadata = {
    ref,
    description: input.description ?? "",
    inputSchema: input.inputSchema ?? {},
    annotations: input.annotations ?? {},
  };
  const call: ToolCall = {
    ref,
    metadata,
    arguments: input.arguments,
  };

  assignIfPresent(call, "runId", input.runId);
  assignIfPresent(call, "callId", input.callId);
  assignIfPresent(call, "client", input.client);
  assignIfPresent(call, "agent", input.agent);
  assignIfPresent(call, "user", input.user);

  const executor: ToolExecutor = {
    execute: async (executionCall) => {
      try {
        const output = await input.execute(executionCall.arguments);
        return {
          status: "success",
          output,
          summary: input.summarizeOutput?.(output) ?? summarizeJson(output),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: "error",
          output: { error: message },
          summary: message,
          error: message,
        };
      }
    },
  };

  const pipelineInput = { config, call, executor };
  assignIfPresent(pipelineInput, "reviewer", input.reviewer ?? runtime?.reviewer);
  assignIfPresent(pipelineInput, "auditPath", input.auditPath ?? runtime?.auditPath);

  return handleToolCall(pipelineInput);
}

export type GuardOptions = Omit<
  GuardActionInput,
  "tool" | "arguments" | "execute"
>;

/**
 * Wraps a function so every call is policy-checked, audited, and (if required)
 * approved. The returned function keeps the original signature and return
 * value; it throws WardenBlockedError when the call is denied or unapproved.
 */
export function guard<A extends JsonObject = JsonObject, R extends JsonValue = JsonValue>(
  tool: string,
  fn: (args: A) => Promise<R> | R,
  options: GuardOptions = {},
): (args: A) => Promise<R> {
  return async (args: A) => {
    const result = await guardAction({
      ...options,
      tool,
      arguments: args,
      execute: (executionArgs) => fn(executionArgs as A),
    });

    if (!result.executed) {
      throw new WardenBlockedError(result);
    }

    return result.output as R;
  };
}

export class WardenBlockedError extends Error {
  readonly result: HandleToolCallResult;

  constructor(result: HandleToolCallResult) {
    super(
      `Warden blocked ${result.auditEvent.tool}: ${result.error ?? result.decision.reason}`,
    );
    this.name = "WardenBlockedError";
    this.result = result;
  }
}

function ensureNamespaced(tool: string, defaultUpstream: string): string {
  const trimmed = tool.trim();
  return trimmed.includes(".") ? trimmed : `${defaultUpstream}.${trimmed}`;
}

function summarizeJson(value: JsonValue): string {
  if (typeof value === "string") {
    return value.slice(0, 500);
  }

  return JSON.stringify(value).slice(0, 500);
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
