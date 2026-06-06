import type { JsonObject, JsonValue } from "../domain/types.js";
import {
  guardAction,
  type GuardActionResult,
  type GuardOptions,
} from "../sdk/guard.js";

/**
 * Structural shape of an OpenAI Agents SDK tool definition (the object passed
 * to `tool({ ... })`). Typed loosely so any zod/JSON-schema parameter type and
 * execute signature wraps cleanly without importing the OpenAI SDK.
 */
export interface OpenAIToolDefinition {
  name: string;
  description?: string;
  parameters?: unknown;
  // `any` here keeps any zod/JSON-schema-inferred execute signature assignable.
  execute: (...args: any[]) => unknown;
  [key: string]: unknown;
}

export interface GuardToolOptions extends GuardOptions {
  /** Upstream namespace for the tool ref. Defaults to "openai". */
  upstream?: string;
  /** Override what the model sees when a call is blocked. */
  onBlocked?: (result: GuardActionResult, def: OpenAIToolDefinition) => unknown;
}

/**
 * Wraps a single OpenAI Agents SDK tool definition so its `execute` is policy-
 * checked, audited, and (if required) approved. On a block, the model receives
 * a readable message instead of the tool running.
 */
export function guardTool<Def extends OpenAIToolDefinition>(
  def: Def,
  options: GuardToolOptions = {},
): Def {
  if (typeof def.execute !== "function") {
    throw new Error(`guardTool: tool "${def.name}" has no execute function.`);
  }

  const { upstream = "openai", onBlocked, ...guardOptions } = options;
  const toolName = `${upstream}.${def.name}`;
  const originalExecute = def.execute;
  const description = guardOptions.description ?? def.description;

  const wrappedExecute = async (
    input: unknown,
    ...rest: unknown[]
  ): Promise<unknown> => {
    const result = await guardAction({
      ...guardOptions,
      ...(description !== undefined ? { description } : {}),
      tool: toolName,
      arguments: asArguments(input),
      execute: () => originalExecute(input, ...rest) as JsonValue,
    });

    if (!result.executed) {
      return onBlocked ? onBlocked(result, def) : blockedMessage(result);
    }

    return result.output;
  };

  return { ...def, execute: wrappedExecute };
}

/** Wraps a whole array of tool definitions — use this so coverage is automatic. */
export function guardTools<Def extends OpenAIToolDefinition>(
  defs: Def[],
  options: GuardToolOptions = {},
): Def[] {
  return defs.map((def) => guardTool(def, options));
}

function asArguments(input: unknown): JsonObject {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return input as JsonObject;
  }
  return { input: input as JsonValue };
}

function blockedMessage(result: GuardActionResult): string {
  const detail = result.error ?? result.decision.reason;
  return `⚠️ This action was blocked by Warden policy (${result.decision.decision}). ${detail}`;
}
