import { createHash } from "node:crypto";
import type { JsonValue } from "../domain/types.js";
import type { PolicyConfig } from "../domain/types.js";

export function hashPolicyConfig(config: PolicyConfig): string {
  return createHash("sha256")
    .update(stableStringify(config))
    .digest("hex")
    .slice(0, 16);
}

function stableStringify(value: JsonValue | PolicyConfig): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );

    return `{${entries
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
