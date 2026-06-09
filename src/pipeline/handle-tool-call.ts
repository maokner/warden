import {
  createApprovalRequest,
  resolveApproval,
  type ApprovalReviewer,
  type ApprovalResolution,
} from "../approval/approval.js";
import { appendAuditEvent, createAuditEvent } from "../audit/logger.js";
import { classifyToolCall } from "../classify/classifier.js";
import type {
  AuditEvent,
  Classification,
  JsonObject,
  JsonValue,
  PolicyConfig,
  PolicyDecision,
  ToolCall,
} from "../domain/types.js";
import { evaluatePolicy } from "../policy/engine.js";
import { hashPolicyConfig } from "../policy/hash.js";
import { redactArguments } from "../policy/redaction.js";

export interface ToolExecutor {
  execute: (call: ToolCall) => Promise<ToolExecutionResult>;
}

export interface ToolExecutionResult {
  status: "success" | "error";
  output?: JsonValue;
  summary?: string;
  error?: string;
}

export interface HandleToolCallInput {
  config: PolicyConfig;
  call: ToolCall;
  executor: ToolExecutor;
  reviewer?: ApprovalReviewer;
  auditPath?: string;
  now?: Date;
}

export interface HandleToolCallResult {
  executed: boolean;
  classification: Classification;
  decision: PolicyDecision;
  approval?: ApprovalResolution;
  auditEvent: AuditEvent;
  output?: JsonValue;
  error?: string;
}

export async function handleToolCall(
  input: HandleToolCallInput,
): Promise<HandleToolCallResult> {
  if (!input.call.metadata) {
    throw new Error("Tool call metadata is required for policy handling.");
  }

  const classification = classifyToolCall(
    input.call.metadata,
    input.call.arguments,
  );
  const decision = evaluatePolicy(
    input.config,
    input.call.ref.fullName,
    classification,
    input.call.arguments,
  );
  const policyVersion = hashPolicyConfig(input.config);
  const start = Date.now();

  if (decision.decision === "deny") {
    return finalize({
      input,
      classification,
      decision,
      policyVersion,
      executed: false,
      responseStatus: "not_executed",
      error: "Tool call denied by policy.",
      durationMs: Date.now() - start,
    });
  }

  if (decision.decision === "require_approval") {
    if (!input.reviewer) {
      return finalize({
        input,
        classification,
        decision,
        policyVersion,
        executed: false,
        responseStatus: "not_executed",
        error: "Approval required, but no reviewer was available.",
        durationMs: Date.now() - start,
      });
    }

    const approvalInput = {
      call: input.call,
      decision,
      redactionFields: input.config.redaction.fields,
      defaultTimeoutSeconds: input.config.approval.timeoutSeconds,
    };
    if (input.now) {
      Object.assign(approvalInput, { now: input.now });
    }

    const approvalRequest = createApprovalRequest(approvalInput);
    const approvalOptions = input.now ? { now: input.now } : {};

    // A broken approval channel (network error, throwing callback) must fail
    // closed and still produce an audit event — never escape as an exception.
    let approval: ApprovalResolution;
    try {
      approval = await resolveApproval(
        approvalRequest,
        input.reviewer,
        approvalOptions,
      );
    } catch (error) {
      approval = {
        status: "failed",
        decidedAt: new Date().toISOString(),
        originalArguments: structuredClone(input.call.arguments),
        reason: `Approval channel error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    if (
      approval.status !== "approved" &&
      approval.status !== "edited_and_approved"
    ) {
      return finalize({
        input,
        classification,
        decision,
        policyVersion,
        approval,
        approvalId: approvalRequest.id,
        executed: false,
        responseStatus: "not_executed",
        error: approval.reason
          ? `Approval ${approval.status}. ${approval.reason}`
          : `Approval ${approval.status}.`,
        durationMs: Date.now() - start,
      });
    }

    const executionArgs = approval.finalArguments;
    if (!executionArgs) {
      return finalize({
        input,
        classification,
        decision,
        policyVersion,
        approval,
        approvalId: approvalRequest.id,
        executed: false,
        responseStatus: "not_executed",
        error: "Approved request did not include final arguments.",
        durationMs: Date.now() - start,
      });
    }

    if (approval.status === "edited_and_approved") {
      const editedCall = { ...input.call, arguments: executionArgs };
      const editedClassification = classifyToolCall(
        input.call.metadata,
        executionArgs,
      );
      const editedDecision = evaluatePolicy(
        input.config,
        input.call.ref.fullName,
        editedClassification,
        executionArgs,
      );

      if (editedDecision.decision === "deny") {
        return finalize({
          input: { ...input, call: editedCall },
          classification: editedClassification,
          decision: editedDecision,
          policyVersion,
          approval,
          approvalId: approvalRequest.id,
          executed: false,
          responseStatus: "not_executed",
          error: "Edited approval arguments are denied by policy.",
          durationMs: Date.now() - start,
        });
      }
    }

    return executeAndFinalize({
      input,
      classification,
      decision,
      policyVersion,
      approval,
      approvalId: approvalRequest.id,
      executionArgs,
      start,
    });
  }

  if (decision.decision === "redact_then_allow") {
    return executeAndFinalize({
      input,
      classification,
      decision,
      policyVersion,
      executionArgs: redactArguments(
        input.call.arguments,
        input.config.redaction.fields,
      ).value,
      start,
    });
  }

  return executeAndFinalize({
    input,
    classification,
    decision,
    policyVersion,
    executionArgs: input.call.arguments,
    start,
  });
}

async function executeAndFinalize(args: {
  input: HandleToolCallInput;
  classification: Classification;
  decision: PolicyDecision;
  policyVersion: string;
  executionArgs: JsonObject;
  start: number;
  approval?: ApprovalResolution;
  approvalId?: string;
}): Promise<HandleToolCallResult> {
  const executionCall: ToolCall = {
    ...args.input.call,
    arguments: args.executionArgs,
  };
  const execution = await args.input.executor.execute(executionCall);

  const finalizeInput = {
    input: args.input,
    classification: args.classification,
    decision: args.decision,
    policyVersion: args.policyVersion,
    approval: args.approval,
    approvalId: args.approvalId,
    executed: true,
    responseStatus: execution.status,
    executedArguments: args.executionArgs,
    durationMs: Date.now() - args.start,
  };

  assignIfPresent(finalizeInput, "approval", args.approval);
  assignIfPresent(finalizeInput, "approvalId", args.approvalId);
  assignIfPresent(finalizeInput, "output", execution.output);
  assignIfPresent(finalizeInput, "responseSummary", execution.summary);
  assignIfPresent(finalizeInput, "error", execution.error);

  return finalize(finalizeInput);
}

function finalize(args: {
  input: HandleToolCallInput;
  classification: Classification;
  decision: PolicyDecision;
  policyVersion: string;
  executed: boolean;
  responseStatus: "not_executed" | "success" | "error";
  durationMs: number;
  approval?: ApprovalResolution;
  approvalId?: string;
  executedArguments?: JsonObject;
  output?: JsonValue;
  responseSummary?: string;
  error?: string;
}): HandleToolCallResult {
  const auditInput = {
    call: args.input.call,
    decision: args.decision,
    policyVersion: args.policyVersion,
    redactionFields: args.input.config.redaction.fields,
    responseStatus: args.responseStatus,
    durationMs: args.durationMs,
  };

  assignIfPresent(auditInput, "approvalId", args.approvalId);
  assignIfPresent(auditInput, "executedArguments", args.executedArguments);
  assignIfPresent(auditInput, "responseSummary", args.responseSummary);
  assignIfPresent(auditInput, "error", args.error);

  const auditEvent = createAuditEvent(auditInput);

  if (args.input.auditPath) {
    appendAuditEvent(args.input.auditPath, auditEvent);
  }

  const result: HandleToolCallResult = {
    executed: args.executed,
    classification: args.classification,
    decision: args.decision,
    auditEvent,
  };

  assignOptional(result, "approval", args.approval);
  assignOptional(result, "output", args.output);
  assignOptional(result, "error", args.error);

  return result;
}

function assignOptional<K extends keyof HandleToolCallResult>(
  result: HandleToolCallResult,
  key: K,
  value: HandleToolCallResult[K] | undefined,
): void {
  if (value !== undefined) {
    result[key] = value;
  }
}

function assignIfPresent<
  T extends Record<string, unknown>,
  K extends string,
  V,
>(target: T, key: K, value: V | undefined): asserts target is T & Record<K, V> {
  if (value !== undefined) {
    Object.assign(target, { [key]: value });
  }
}
