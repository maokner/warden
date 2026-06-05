import { makeToolRef } from "../src/domain/tool-ref.js";
import type { JsonObject, ToolMetadata } from "../src/domain/types.js";

export function toolMetadata(
  fullName: string,
  options: {
    description?: string;
    inputSchema?: JsonObject;
    annotations?: JsonObject;
  } = {},
): ToolMetadata {
  const [upstream, ...nameParts] = fullName.split(".");
  if (!upstream || nameParts.length === 0) {
    throw new Error(`Invalid test tool name: ${fullName}`);
  }

  return {
    ref: makeToolRef(upstream, nameParts.join(".")),
    description: options.description ?? "",
    inputSchema: options.inputSchema ?? {},
    annotations: options.annotations ?? {},
  };
}
