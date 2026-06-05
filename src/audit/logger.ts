import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type {
  AuditEvent,
  DecisionType,
  JsonObject,
  PolicyDecision,
  RiskLabel,
  ToolCall,
} from "../domain/types.js";
import { redactArguments } from "../policy/redaction.js";

export interface CreateAuditEventInput {
  call: ToolCall;
  decision: PolicyDecision;
  policyVersion: string;
  redactionFields: string[];
  approvalId?: string;
  executedArguments?: JsonObject;
  responseSummary?: string;
  responseStatus?: "not_executed" | "success" | "error";
  durationMs?: number;
  error?: string;
}

export function createAuditEvent(input: CreateAuditEventInput): AuditEvent {
  const redacted = redactArguments(input.call.arguments, input.redactionFields);
  const executedRedacted =
    input.executedArguments === undefined
      ? undefined
      : redactArguments(input.executedArguments, input.redactionFields);
  const now = new Date().toISOString();
  const runId = input.call.runId ?? "run_unknown";
  const callId = input.call.callId ?? `call_${cryptoSafeId()}`;

  const event: AuditEvent = {
    id: `evt_${cryptoSafeId()}`,
    runId,
    callId,
    timestamp: now,
    client: input.call.client ?? "unknown_client",
    agent: input.call.agent ?? "unknown_agent",
    user: input.call.user ?? "unknown_user",
    upstream: input.call.ref.upstream,
    tool: input.call.ref.fullName,
    riskLabels: [...input.decision.riskLabels],
    policyVersion: input.policyVersion,
    decision: input.decision.decision,
    policyRule: input.decision.rule,
    policyReason: input.decision.reason,
    requestArguments: redacted.value,
    redactedPaths: redacted.redactedPaths,
    responseStatus: input.responseStatus ?? "not_executed",
  };

  assignOptional(event, "approvalId", input.approvalId);
  assignOptional(event, "executedArguments", executedRedacted?.value);
  assignOptional(event, "responseSummary", input.responseSummary);
  assignOptional(event, "durationMs", input.durationMs);
  assignOptional(event, "error", input.error);

  return event;
}

export function appendAuditEvent(path: string, event: AuditEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(event)}\n`, { flag: "a" });
}

export function readAuditEvents(path: string): AuditEvent[] {
  const content = readFileSync(path, "utf8").trim();
  if (!content) {
    return [];
  }

  return content.split("\n").map((line) => JSON.parse(line) as AuditEvent);
}

function assignOptional<K extends keyof AuditEvent>(
  event: AuditEvent,
  key: K,
  value: AuditEvent[K] | undefined,
): void {
  if (value !== undefined) {
    event[key] = value;
  }
}

function cryptoSafeId(): string {
  return randomUUID().replace(/-/g, "");
}

export type { AuditEvent, DecisionType, JsonObject, RiskLabel };
