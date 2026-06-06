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
  // A raw tool definition exposes `execute`; an already-constructed
  // `@openai/agents` FunctionTool exposes `invoke` instead. Either is accepted.
  execute?: (...args: any[]) => unknown;
  invoke?: (...args: any[]) => unknown;
  [key: string]: unknown;
}

export interface GuardToolOptions extends GuardOptions {
  /** Upstream namespace for the tool ref. Defaults to "openai". */
  upstream?: string;
  /** Override what the model sees when a call is blocked. */
  onBlocked?: (result: GuardActionResult, def: OpenAIToolDefinition) => unknown;
}

/**
 * Wraps a single OpenAI Agents SDK tool so it is policy-checked, audited, and
 * (if required) approved. Works two ways with no extra config:
 *
 *  - a raw tool definition (the object you pass to `tool({ ... })`, has
 *    `execute`) — wrap before `.map(tool)`;
 *  - an already-constructed `FunctionTool` (the value returned by `tool(...)`,
 *    has `invoke`) — wrap it directly and drop it straight into `new Agent(...)`.
 *
 * On a block, the model receives a readable message instead of the tool running.
 */
export function guardTool<Def extends OpenAIToolDefinition>(
  def: Def,
  options: GuardToolOptions = {},
): Def {
  const { upstream = "openai", onBlocked, ...guardOptions } = options;
  const toolName = `${upstream}.${def.name}`;
  const description = guardOptions.description ?? def.description;
  const inputSchema =
    guardOptions.inputSchema ?? inputSchemaFromParameters(def.parameters);

  const runGuard = (
    args: JsonObject,
    runOriginal: (finalArgs: JsonObject) => unknown,
  ) =>
    guardAction({
      ...guardOptions,
      ...(description !== undefined ? { description } : {}),
      inputSchema,
      tool: toolName,
      arguments: args,
      execute: (finalArgs) => runOriginal(finalArgs) as JsonValue,
    });

  // Raw tool definition: wrap execute(). Original behavior preserved — the
  // original input object is passed straight through.
  if (typeof def.execute === "function") {
    const originalExecute = def.execute;
    const wrappedExecute = async (
      input: unknown,
      ...rest: unknown[]
    ): Promise<unknown> => {
      const result = await runGuard(asArguments(input), () =>
        originalExecute(input, ...rest),
      );
      if (!result.executed) {
        return onBlocked ? onBlocked(result, def) : blockedMessage(result);
      }
      return result.output;
    };
    return { ...def, execute: wrappedExecute };
  }

  // Already-constructed FunctionTool: wrap invoke(runContext, jsonArgsString).
  // Re-serializing the (possibly approver-edited) arguments keeps edits working.
  if (typeof def.invoke === "function") {
    const originalInvoke = def.invoke;
    const wrappedInvoke = async (
      runContext: unknown,
      input: unknown,
      ...rest: unknown[]
    ): Promise<unknown> => {
      const result = await runGuard(argsFromInvokeInput(input), (finalArgs) =>
        originalInvoke(runContext, serializeInvokeInput(input, finalArgs), ...rest),
      );
      if (!result.executed) {
        return onBlocked ? onBlocked(result, def) : blockedMessage(result);
      }
      return result.output;
    };
    return { ...def, invoke: wrappedInvoke };
  }

  throw new Error(
    `guardTool: tool "${def.name}" has neither an execute() nor an invoke() function.`,
  );
}

/**
 * Wraps a whole array of tools — use this so coverage stays automatic as tools
 * are added. Accepts raw definitions, already-constructed FunctionTools, or a
 * mix of both, so it drops into a new or existing agent unchanged:
 *
 *   const agent = new Agent({ tools: guardTools(myExistingTools) });
 */
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

/** FunctionTool.invoke receives the raw JSON-string arguments; parse to an object. */
function argsFromInvokeInput(input: unknown): JsonObject {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) {
      return {};
    }
    try {
      return asArguments(JSON.parse(trimmed));
    } catch {
      return { input };
    }
  }
  return asArguments(input);
}

/**
 * Re-serialize the final (possibly approver-edited) arguments back into the
 * shape FunctionTool.invoke expects so edits take effect. Strings round-trip as
 * JSON; a non-object input we wrapped under `input` is unwrapped on the way out.
 */
function serializeInvokeInput(originalInput: unknown, finalArgs: JsonObject): unknown {
  if (typeof originalInput !== "string") {
    return finalArgs;
  }
  const keys = Object.keys(finalArgs);
  if (keys.length === 1 && keys[0] === "input") {
    return JSON.stringify(finalArgs["input"]);
  }
  return JSON.stringify(finalArgs);
}

function blockedMessage(result: GuardActionResult): string {
  const detail = result.error ?? result.decision.reason;
  return `Warden blocked this action (${result.decision.decision}). ${detail}`;
}

function inputSchemaFromParameters(parameters: unknown): JsonObject {
  if (parameters === undefined) {
    return {};
  }

  const json = toJsonValue(parameters, new WeakSet<object>(), 0);
  const schema: JsonObject =
    isJsonObject(json) ? json : { value: json };
  const signals = collectParameterSignals(parameters);

  if (signals.length > 0) {
    schema["warden_parameter_signals"] = signals;
  }

  return schema;
}

function toJsonValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "function") {
    return `[Function${value.name ? `:${value.name}` : ""}]`;
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  if (depth >= 4) {
    return `[${constructorName(value)}]`;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((entry) => toJsonValue(entry, seen, depth + 1));
  }

  const result: JsonObject = {};
  const object = value as Record<string, unknown>;

  for (const [key, nested] of Object.entries(object).slice(0, 100)) {
    if (nested !== undefined) {
      result[key] = toJsonValue(nested, seen, depth + 1);
    }
  }

  const shape = getShape(object);
  if (shape && result["shape"] === undefined) {
    result["shape"] = toJsonValue(shape, seen, depth + 1);
  }

  return result;
}

function collectParameterSignals(parameters: unknown): string[] {
  const signals = new Set<string>();
  collectSignals(parameters, signals, new WeakSet<object>(), 0);
  return [...signals].slice(0, 200);
}

function collectSignals(
  value: unknown,
  signals: Set<string>,
  seen: WeakSet<object>,
  depth: number,
): void {
  if (signals.size >= 200 || value === undefined || value === null || depth > 5) {
    return;
  }

  if (typeof value === "string") {
    addSignal(signals, value);
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 50)) {
      collectSignals(entry, signals, seen, depth + 1);
    }
    return;
  }

  const object = value as Record<string, unknown>;
  const shape = getShape(object);
  if (shape) {
    for (const [key, nested] of Object.entries(shape)) {
      addSignal(signals, key);
      collectSignals(nested, signals, seen, depth + 1);
    }
  }

  const properties = object["properties"];
  if (isJsonObjectLike(properties)) {
    for (const [key, nested] of Object.entries(properties)) {
      addSignal(signals, key);
      collectSignals(nested, signals, seen, depth + 1);
    }
  }

  for (const [key, nested] of Object.entries(object).slice(0, 100)) {
    addSignal(signals, key);
    collectSignals(nested, signals, seen, depth + 1);
  }
}

function getShape(object: Record<string, unknown>): unknown {
  const directShape = object["shape"];
  if (typeof directShape === "function") {
    return directShape();
  }
  if (directShape !== undefined) {
    return directShape;
  }

  const def = object["_def"];
  if (!isJsonObjectLike(def)) {
    return undefined;
  }

  const defShape = def["shape"];
  return typeof defShape === "function" ? defShape() : defShape;
}

function addSignal(signals: Set<string>, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }

  signals.add(trimmed.slice(0, 200));

  for (const token of trimmed
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)) {
    if (token.length >= 3) {
      signals.add(token.slice(0, 200));
    }
  }
}

function constructorName(value: object): string {
  return value.constructor?.name ?? "Object";
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
