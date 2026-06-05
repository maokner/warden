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

export interface GuardActionInput {
  config: PolicyConfig;
  tool: string;
  arguments: JsonObject;
  execute: (args: JsonObject) => Promise<JsonValue> | JsonValue;
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
}

export type GuardActionResult = HandleToolCallResult;

export async function guardAction(
  input: GuardActionInput,
): Promise<GuardActionResult> {
  const ref = parseToolRef(input.tool);
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

  const pipelineInput = {
    config: input.config,
    call,
    executor,
  };

  assignIfPresent(pipelineInput, "reviewer", input.reviewer);
  assignIfPresent(pipelineInput, "auditPath", input.auditPath);

  return handleToolCall(pipelineInput);
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
