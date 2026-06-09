import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  APPROVAL_METHODS,
  DECISION_TYPES,
  RISK_LABELS,
  type ApprovalMethod,
  type ApprovalPolicy,
  type ArgumentMatcher,
  type DecisionType,
  type GlobalApprovalConfig,
  type JsonObject,
  type JsonPrimitive,
  type PolicyConfig,
  type RiskLabel,
  type ToolPolicy,
  type ToolRule,
} from "../domain/types.js";
import { parseTimeout } from "../approval/methods.js";
import { MATCHER_KEYS } from "./rules.js";
import { defaultPolicyConfig } from "./defaults.js";

export function loadPolicyConfig(path: string): PolicyConfig {
  return parsePolicyConfig(readFileSync(path, "utf8"));
}

export function parsePolicyConfig(source: string): PolicyConfig {
  const parsed = parse(source) as unknown;
  return normalizePolicyConfig(parsed);
}

export function normalizePolicyConfig(value: unknown): PolicyConfig {
  const base = defaultPolicyConfig();

  if (value === null || value === undefined) {
    return base;
  }

  const root = expectObject(value, "policy config");
  assertKnownKeys(
    root,
    ["defaults", "tools", "redaction", "approval", "audit"],
    "policy config",
  );

  return {
    defaults: normalizeDefaults(root["defaults"], base.defaults),
    tools: normalizeTools(root["tools"]),
    redaction: normalizeRedaction(root["redaction"], base.redaction.fields),
    auditPath: normalizeAuditPath(root["audit"], base.auditPath),
    approval: normalizeGlobalApproval(root["approval"], base.approval),
  };
}

function normalizeGlobalApproval(
  value: unknown,
  base: GlobalApprovalConfig,
): GlobalApprovalConfig {
  if (value === undefined) {
    return { ...base };
  }

  const object = expectObject(value, "approval");
  assertKnownKeys(object, ["method", "timeout"], "approval");
  const result: GlobalApprovalConfig = { ...base };

  if (object["method"] !== undefined) {
    const method = object["method"];
    if (
      typeof method !== "string" ||
      !APPROVAL_METHODS.includes(method as ApprovalMethod)
    ) {
      throw new Error(
        `approval.method must be one of: ${APPROVAL_METHODS.join(", ")}.`,
      );
    }
    result.method = method as ApprovalMethod;
  }

  if (object["timeout"] !== undefined) {
    const timeout = object["timeout"];
    if (typeof timeout !== "string" && typeof timeout !== "number") {
      throw new Error("approval.timeout must be a preset name or seconds.");
    }
    result.timeoutSeconds = parseTimeout(timeout);
  }

  return result;
}

function normalizeDefaults(
  value: unknown,
  base: Record<RiskLabel, DecisionType>,
): Record<RiskLabel, DecisionType> {
  if (value === undefined) {
    return { ...base };
  }

  const defaults = { ...base };
  const object = expectObject(value, "defaults");

  for (const [risk, decision] of Object.entries(object)) {
    assertRisk(risk);
    defaults[risk] = parseDecision(decision, `defaults.${risk}`);
  }

  return defaults;
}

function normalizeTools(value: unknown): Record<string, ToolPolicy> {
  if (value === undefined) {
    return {};
  }

  const object = expectObject(value, "tools");
  const tools: Record<string, ToolPolicy> = {};

  for (const [toolName, rawPolicy] of Object.entries(object)) {
    const policyObject = expectObject(rawPolicy, `tools.${toolName}`);
    assertKnownKeys(
      policyObject,
      ["decision", "risks", "acknowledge_risks", "rules", "approval"],
      `tools.${toolName}`,
    );
    const policy: ToolPolicy = {};

    if (policyObject["decision"] !== undefined) {
      policy.decision = parseDecision(
        policyObject["decision"],
        `tools.${toolName}.decision`,
      );
    }

    if (policyObject["risks"] !== undefined) {
      policy.risks = normalizeRiskList(
        policyObject["risks"],
        `tools.${toolName}.risks`,
      );
    }

    if (policyObject["acknowledge_risks"] !== undefined) {
      policy.acknowledgeRisks = normalizeRiskList(
        policyObject["acknowledge_risks"],
        `tools.${toolName}.acknowledge_risks`,
      );
    }

    if (policyObject["rules"] !== undefined) {
      policy.rules = normalizeRules(
        policyObject["rules"],
        `tools.${toolName}.rules`,
      );
    }

    if (policyObject["approval"] !== undefined) {
      policy.approval = normalizeApproval(
        policyObject["approval"],
        `tools.${toolName}.approval`,
      );
    }

    tools[toolName] = policy;
  }

  return tools;
}

function normalizeRiskList(value: unknown, path: string): RiskLabel[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be a list.`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`${path}[${index}] must be a string.`);
    }

    assertRisk(entry);
    return entry;
  });
}

function normalizeRules(value: unknown, path: string): ToolRule[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be a list of rules.`);
  }

  return value.map((entry, index) => {
    const rulePath = `${path}[${index}]`;
    const object = expectObject(entry, rulePath);
    assertKnownKeys(object, ["when", "decision"], rulePath);

    if (object["when"] === undefined) {
      throw new Error(`${rulePath}.when is required.`);
    }
    if (object["decision"] === undefined) {
      throw new Error(`${rulePath}.decision is required.`);
    }

    const whenObject = expectObject(object["when"], `${rulePath}.when`);
    const conditions = Object.entries(whenObject);
    if (conditions.length === 0) {
      throw new Error(`${rulePath}.when must contain at least one condition.`);
    }

    const when: Record<string, ArgumentMatcher> = {};
    for (const [argumentPath, matcher] of conditions) {
      when[argumentPath] = normalizeMatcher(
        matcher,
        `${rulePath}.when.${argumentPath}`,
      );
    }

    return {
      when,
      decision: parseDecision(object["decision"], `${rulePath}.decision`),
    };
  });
}

/** A scalar is shorthand for `eq`; an object holds one or more matchers. */
function normalizeMatcher(value: unknown, path: string): ArgumentMatcher {
  if (isPrimitive(value)) {
    return { eq: value };
  }

  if (!isPlainObject(value)) {
    throw new Error(
      `${path} must be a scalar (shorthand for eq) or a matcher object using: ${MATCHER_KEYS.join(", ")}.`,
    );
  }

  assertKnownKeys(value, [...MATCHER_KEYS], path);
  if (Object.keys(value).length === 0) {
    throw new Error(`${path} must contain at least one matcher.`);
  }

  const matcher: ArgumentMatcher = {};

  if (value["eq"] !== undefined) {
    matcher.eq = expectPrimitive(value["eq"], `${path}.eq`);
  }
  if (value["ne"] !== undefined) {
    matcher.ne = expectPrimitive(value["ne"], `${path}.ne`);
  }
  for (const key of ["gt", "gte", "lt", "lte"] as const) {
    const raw = value[key];
    if (raw === undefined) {
      continue;
    }
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      throw new Error(`${path}.${key} must be a finite number.`);
    }
    matcher[key] = raw;
  }
  if (value["in"] !== undefined) {
    if (!Array.isArray(value["in"]) || value["in"].length === 0) {
      throw new Error(`${path}.in must be a non-empty list.`);
    }
    matcher.in = value["in"].map((entry, index) =>
      expectPrimitive(entry, `${path}.in[${index}]`),
    );
  }
  if (value["contains"] !== undefined) {
    matcher.contains = expectPrimitive(value["contains"], `${path}.contains`);
  }
  if (value["matches"] !== undefined) {
    if (typeof value["matches"] !== "string") {
      throw new Error(`${path}.matches must be a regular expression string.`);
    }
    try {
      new RegExp(value["matches"]);
    } catch {
      throw new Error(`${path}.matches is not a valid regular expression.`);
    }
    matcher.matches = value["matches"];
  }
  if (value["exists"] !== undefined) {
    if (typeof value["exists"] !== "boolean") {
      throw new Error(`${path}.exists must be a boolean.`);
    }
    matcher.exists = value["exists"];
  }

  return matcher;
}

function isPrimitive(value: unknown): value is JsonPrimitive {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function expectPrimitive(value: unknown, path: string): JsonPrimitive {
  if (!isPrimitive(value)) {
    throw new Error(`${path} must be a string, number, boolean, or null.`);
  }
  return value;
}

function normalizeApproval(value: unknown, path: string): ApprovalPolicy {
  const object = expectObject(value, path);
  assertKnownKeys(
    object,
    ["timeout_seconds", "approvers", "require_reason"],
    path,
  );
  const approval: ApprovalPolicy = {};

  if (object["timeout_seconds"] !== undefined) {
    if (
      typeof object["timeout_seconds"] !== "number" ||
      !Number.isInteger(object["timeout_seconds"]) ||
      object["timeout_seconds"] <= 0
    ) {
      throw new Error(`${path}.timeout_seconds must be a positive integer.`);
    }
    approval.timeoutSeconds = object["timeout_seconds"];
  }

  if (object["approvers"] !== undefined) {
    if (!Array.isArray(object["approvers"])) {
      throw new Error(`${path}.approvers must be a list.`);
    }

    approval.approvers = object["approvers"].map((entry, index) => {
      if (typeof entry !== "string" || !entry.trim()) {
        throw new Error(`${path}.approvers[${index}] must be a string.`);
      }
      return entry;
    });
  }

  if (object["require_reason"] !== undefined) {
    if (typeof object["require_reason"] !== "boolean") {
      throw new Error(`${path}.require_reason must be a boolean.`);
    }
    approval.requireReason = object["require_reason"];
  }

  return approval;
}

function normalizeRedaction(
  value: unknown,
  baseFields: string[],
): { fields: string[] } {
  if (value === undefined) {
    return { fields: [...baseFields] };
  }

  const object = expectObject(value, "redaction");
  assertKnownKeys(object, ["fields"], "redaction");
  const rawFields = object["fields"];

  if (rawFields === undefined) {
    return { fields: [...baseFields] };
  }

  if (!Array.isArray(rawFields)) {
    throw new Error("redaction.fields must be a list.");
  }

  const userFields = rawFields.map((field, index) => {
    if (typeof field !== "string" || !field.trim()) {
      throw new Error(`redaction.fields[${index}] must be a string.`);
    }
    return field;
  });

  return { fields: mergeFields(baseFields, userFields) };
}

function mergeFields(baseFields: string[], userFields: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const field of [...baseFields, ...userFields]) {
    const normalized = field.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      merged.push(field);
    }
  }

  return merged;
}

function normalizeAuditPath(value: unknown, basePath: string): string {
  if (value === undefined) {
    return basePath;
  }

  const object = expectObject(value, "audit");
  assertKnownKeys(object, ["path"], "audit");
  const rawPath = object["path"];

  if (rawPath === undefined) {
    return basePath;
  }

  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new Error("audit.path must be a string.");
  }

  return rawPath;
}

function parseDecision(value: unknown, path: string): DecisionType {
  if (
    typeof value !== "string" ||
    !DECISION_TYPES.includes(value as DecisionType)
  ) {
    throw new Error(
      `${path} must be one of: ${DECISION_TYPES.join(", ")}.`,
    );
  }

  return value as DecisionType;
}

function assertRisk(value: string): asserts value is RiskLabel {
  if (!RISK_LABELS.includes(value as RiskLabel)) {
    throw new Error(`${value} is not a valid risk label.`);
  }
}

function expectObject(value: unknown, path: string): JsonObject {
  if (!isPlainObject(value)) {
    throw new Error(`${path} must be an object.`);
  }

  return value;
}

/**
 * Unknown keys are config bugs (typos, sections from other tools) and must
 * not be silently ignored in a policy file — fail fast with the allowed set.
 */
function assertKnownKeys(
  object: JsonObject,
  allowed: string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(object).filter((key) => !allowedSet.has(key));

  if (unknown.length > 0) {
    throw new Error(
      `${path} has unknown key${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Allowed keys: ${allowed.join(", ")}.`,
    );
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
