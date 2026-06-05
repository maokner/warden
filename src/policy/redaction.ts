import type { JsonObject, JsonValue } from "../domain/types.js";

export interface RedactionResult {
  value: JsonObject;
  redactedPaths: string[];
}

const REDACTED = "[REDACTED]";
const SECRET_TOKEN_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bghp_[A-Za-z0-9_]{12,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{12,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]{8,}@/g,
];
const SECRET_KEY_VALUE_PATTERNS: RegExp[] = [
  /\b(password|passwd|pwd|token|api[_-]?key|secret)=([^\\s&]+)\b/gi,
];

export function redactArguments(
  args: JsonObject,
  fields: string[],
): RedactionResult {
  const redactedPaths: string[] = [];
  const normalizedFields = fields.map(normalizeKey).filter(Boolean);
  const value = redactValue(args, normalizedFields, "$", redactedPaths);

  if (!isJsonObject(value)) {
    throw new Error("Redaction produced a non-object argument payload.");
  }

  return { value, redactedPaths };
}

function redactValue(
  value: JsonValue,
  fields: string[],
  path: string,
  redactedPaths: string[],
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      redactValue(entry, fields, `${path}[${index}]`, redactedPaths),
    );
  }

  if (isJsonObject(value)) {
    const result: JsonObject = {};

    for (const [key, nested] of Object.entries(value)) {
      const nestedPath = `${path}.${key}`;
      if (shouldRedact(key, fields)) {
        result[key] = REDACTED;
        redactedPaths.push(nestedPath);
      } else {
        result[key] = redactValue(nested, fields, nestedPath, redactedPaths);
      }
    }

    return result;
  }

  if (typeof value === "string") {
    return redactSecretSubstrings(value, redactedPaths, path);
  }

  return value;
}

function shouldRedact(key: string, fields: string[]): boolean {
  const normalizedKey = normalizeKey(key);

  return fields.some((field) => {
    if (normalizedKey === field) {
      return true;
    }

    return field.length >= 4 && normalizedKey.includes(field);
  });
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function redactSecretSubstrings(
  value: string,
  redactedPaths: string[],
  path: string,
): string {
  let redacted = value;

  for (const pattern of SECRET_TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }

  for (const pattern of SECRET_KEY_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, key: string) => {
      return `${key}=${REDACTED}`;
    });
  }

  if (redacted !== value) {
    redactedPaths.push(path);
  }

  return redacted;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
