import type { ToolRef } from "./types.js";

const REF_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;

export function makeToolRef(upstream: string, name: string): ToolRef {
  const cleanUpstream = upstream.trim();
  const cleanName = name.trim();

  if (!cleanUpstream) {
    throw new Error("Tool upstream is required.");
  }

  if (!cleanName) {
    throw new Error("Tool name is required.");
  }

  if (cleanUpstream.includes(".")) {
    throw new Error("Tool upstream must not contain dots.");
  }

  return {
    upstream: cleanUpstream,
    name: cleanName,
    fullName: `${cleanUpstream}.${cleanName}`,
  };
}

export function parseToolRef(value: string): ToolRef {
  const cleanValue = value.trim();

  if (!REF_PATTERN.test(cleanValue)) {
    throw new Error(
      `Invalid tool reference "${value}". Expected format "upstream.tool_name".`,
    );
  }

  const dotIndex = cleanValue.indexOf(".");
  return makeToolRef(
    cleanValue.slice(0, dotIndex),
    cleanValue.slice(dotIndex + 1),
  );
}
