import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  DECISION_TYPES,
  RISK_LABELS,
  type ApprovalPolicy,
  type DecisionType,
  type JsonObject,
  type PolicyConfig,
  type RiskLabel,
  type ToolPolicy,
  type UpstreamConfig,
} from "../domain/types.js";
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

  return {
    defaults: normalizeDefaults(root["defaults"], base.defaults),
    tools: normalizeTools(root["tools"]),
    redaction: normalizeRedaction(root["redaction"], base.redaction.fields),
    auditPath: normalizeAuditPath(root["audit"], base.auditPath),
    upstreams: normalizeUpstreams(root["upstreams"]),
  };
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
    const policy: ToolPolicy = {};

    if (policyObject["decision"] !== undefined) {
      policy.decision = parseDecision(
        policyObject["decision"],
        `tools.${toolName}.decision`,
      );
    }

    if (policyObject["risks"] !== undefined) {
      policy.risks = normalizeRisks(policyObject["risks"], toolName);
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

function normalizeRisks(value: unknown, toolName: string): RiskLabel[] {
  if (!Array.isArray(value)) {
    throw new Error(`tools.${toolName}.risks must be a list.`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`tools.${toolName}.risks[${index}] must be a string.`);
    }

    assertRisk(entry);
    return entry;
  });
}

function normalizeApproval(value: unknown, path: string): ApprovalPolicy {
  const object = expectObject(value, path);
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
  const rawPath = object["path"];

  if (rawPath === undefined) {
    return basePath;
  }

  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new Error("audit.path must be a string.");
  }

  return rawPath;
}

function normalizeUpstreams(value: unknown): Record<string, UpstreamConfig> {
  if (value === undefined) {
    return {};
  }

  const object = expectObject(value, "upstreams");
  const upstreams: Record<string, UpstreamConfig> = {};

  for (const [name, rawConfig] of Object.entries(object)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new Error(`upstreams.${name} must use only letters, numbers, underscores, and dashes.`);
    }

    const config = expectObject(rawConfig, `upstreams.${name}`);
    const transport = config["transport"] ?? "stdio";
    if (transport !== "stdio") {
      throw new Error(`upstreams.${name}.transport must be "stdio".`);
    }

    if (typeof config["command"] !== "string" || !config["command"].trim()) {
      throw new Error(`upstreams.${name}.command must be a non-empty string.`);
    }

    upstreams[name] = {
      transport: "stdio",
      command: config["command"],
      args: normalizeStringList(config["args"], `upstreams.${name}.args`),
      env: normalizeEnv(config["env"], `upstreams.${name}.env`),
      startupTimeoutMs: normalizePositiveInteger(
        config["startup_timeout_ms"],
        `upstreams.${name}.startup_timeout_ms`,
        10_000,
      ),
      toolTimeoutMs: normalizePositiveInteger(
        config["tool_timeout_ms"],
        `upstreams.${name}.tool_timeout_ms`,
        60_000,
      ),
    };

    if (config["cwd"] !== undefined) {
      if (typeof config["cwd"] !== "string" || !config["cwd"].trim()) {
        throw new Error(`upstreams.${name}.cwd must be a non-empty string.`);
      }
      upstreams[name].cwd = config["cwd"];
    }
  }

  return upstreams;
}

function normalizeStringList(value: unknown, path: string): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${path} must be a list.`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`${path}[${index}] must be a string.`);
    }

    return entry;
  });
}

function normalizeEnv(value: unknown, path: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }

  const object = expectObject(value, path);
  const env: Record<string, string> = {};

  for (const [key, entry] of Object.entries(object)) {
    if (typeof entry !== "string") {
      throw new Error(`${path}.${key} must be a string.`);
    }

    env[key] = entry;
  }

  return env;
}

function normalizePositiveInteger(
  value: unknown,
  path: string,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new Error(`${path} must be a positive integer.`);
  }

  return value;
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

function isPlainObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
