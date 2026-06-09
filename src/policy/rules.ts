import type {
  ArgumentMatcher,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ToolRule,
} from "../domain/types.js";

export const MATCHER_KEYS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "contains",
  "matches",
  "exists",
] as const;

export type MatcherKey = (typeof MATCHER_KEYS)[number];

export interface RuleMatch {
  index: number;
  rule: ToolRule;
  description: string;
}

/** Returns the first rule whose every condition holds for these arguments. */
export function matchRules(
  rules: ToolRule[],
  args: JsonObject,
): RuleMatch | undefined {
  for (const [index, rule] of rules.entries()) {
    if (ruleMatches(rule, args)) {
      return { index, rule, description: describeRule(rule) };
    }
  }

  return undefined;
}

function ruleMatches(rule: ToolRule, args: JsonObject): boolean {
  return Object.entries(rule.when).every(([path, matcher]) =>
    matcherHolds(matcher, resolveArgumentPath(args, path)),
  );
}

/** Dot-path lookup into the arguments object (objects only, no array indices). */
export function resolveArgumentPath(
  args: JsonObject,
  path: string,
): JsonValue | undefined {
  let current: JsonValue | undefined = args;

  for (const segment of path.split(".")) {
    if (!isJsonObject(current)) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

/**
 * Every matcher present must hold. Apart from `exists: false`, a missing
 * argument never satisfies a matcher, so rules fail safe to the next rule or
 * the surrounding policy instead of firing on absent data.
 */
function matcherHolds(
  matcher: ArgumentMatcher,
  value: JsonValue | undefined,
): boolean {
  if (matcher.exists !== undefined && (value !== undefined) !== matcher.exists) {
    return false;
  }

  if (matcher.eq !== undefined && !primitiveEquals(value, matcher.eq)) {
    return false;
  }

  if (
    matcher.ne !== undefined &&
    (value === undefined || primitiveEquals(value, matcher.ne))
  ) {
    return false;
  }

  for (const [key, threshold] of numericComparisons(matcher)) {
    const numeric = toFiniteNumber(value);
    if (numeric === undefined || !compareNumeric(key, numeric, threshold)) {
      return false;
    }
  }

  if (
    matcher.in !== undefined &&
    !matcher.in.some((entry) => primitiveEquals(value, entry))
  ) {
    return false;
  }

  if (matcher.contains !== undefined && !containsValue(value, matcher.contains)) {
    return false;
  }

  if (matcher.matches !== undefined) {
    if (typeof value !== "string" || !new RegExp(matcher.matches).test(value)) {
      return false;
    }
  }

  return true;
}

function numericComparisons(
  matcher: ArgumentMatcher,
): Array<["gt" | "gte" | "lt" | "lte", number]> {
  const comparisons: Array<["gt" | "gte" | "lt" | "lte", number]> = [];

  if (matcher.gt !== undefined) comparisons.push(["gt", matcher.gt]);
  if (matcher.gte !== undefined) comparisons.push(["gte", matcher.gte]);
  if (matcher.lt !== undefined) comparisons.push(["lt", matcher.lt]);
  if (matcher.lte !== undefined) comparisons.push(["lte", matcher.lte]);

  return comparisons;
}

function compareNumeric(
  key: "gt" | "gte" | "lt" | "lte",
  value: number,
  threshold: number,
): boolean {
  switch (key) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
  }
}

/** Numbers as-is; numeric strings coerced so `"900"` still trips a threshold. */
function toFiniteNumber(value: JsonValue | undefined): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }

  return undefined;
}

function primitiveEquals(value: JsonValue | undefined, expected: JsonValue): boolean {
  if (value === undefined || isComposite(value) || isComposite(expected)) {
    return false;
  }

  return value === expected;
}

function containsValue(
  value: JsonValue | undefined,
  needle: JsonPrimitive,
): boolean {
  if (typeof value === "string") {
    return value.includes(String(needle));
  }

  if (Array.isArray(value)) {
    return value.some((entry) => primitiveEquals(entry, needle));
  }

  return false;
}

export function describeRule(rule: ToolRule): string {
  return Object.entries(rule.when)
    .map(([path, matcher]) => describeMatcher(path, matcher))
    .join(" and ");
}

function describeMatcher(path: string, matcher: ArgumentMatcher): string {
  const target = `arguments.${path}`;
  const parts: string[] = [];

  if (matcher.exists !== undefined) {
    parts.push(matcher.exists ? `${target} exists` : `${target} is absent`);
  }
  if (matcher.eq !== undefined) {
    parts.push(`${target} == ${JSON.stringify(matcher.eq)}`);
  }
  if (matcher.ne !== undefined) {
    parts.push(`${target} != ${JSON.stringify(matcher.ne)}`);
  }
  if (matcher.gt !== undefined) parts.push(`${target} > ${matcher.gt}`);
  if (matcher.gte !== undefined) parts.push(`${target} >= ${matcher.gte}`);
  if (matcher.lt !== undefined) parts.push(`${target} < ${matcher.lt}`);
  if (matcher.lte !== undefined) parts.push(`${target} <= ${matcher.lte}`);
  if (matcher.in !== undefined) {
    parts.push(`${target} in [${matcher.in.map((entry) => JSON.stringify(entry)).join(", ")}]`);
  }
  if (matcher.contains !== undefined) {
    parts.push(`${target} contains ${JSON.stringify(matcher.contains)}`);
  }
  if (matcher.matches !== undefined) {
    parts.push(`${target} matches /${matcher.matches}/`);
  }

  return parts.join(" and ");
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

function isComposite(value: JsonValue): boolean {
  return typeof value === "object" && value !== null;
}
