import { randomUUID } from "node:crypto";
import type {
  ApprovalRequest,
  JsonObject,
  PolicyDecision,
  ToolCall,
} from "../domain/types.js";
import { redactArguments } from "../policy/redaction.js";

export interface CreateApprovalRequestInput {
  call: ToolCall;
  decision: PolicyDecision;
  redactionFields: string[];
  now?: Date;
}

export type ApprovalAction =
  | {
      action: "approve";
      approver: string;
      reason?: string;
    }
  | {
      action: "reject";
      approver: string;
      reason?: string;
    }
  | {
      action: "edit";
      approver: string;
      editedArguments: JsonObject;
      reason?: string;
    };

export interface ApprovalReviewer {
  review: (request: ApprovalRequest) => Promise<ApprovalAction>;
}

export interface ApprovalResolution {
  status: Exclude<ApprovalRequest["status"], "pending">;
  approver?: string;
  reason?: string;
  decidedAt: string;
  originalArguments: JsonObject;
  finalArguments?: JsonObject;
}

export function createApprovalRequest(
  input: CreateApprovalRequestInput,
): ApprovalRequest {
  const timeoutSeconds = input.decision.approval?.timeoutSeconds ?? 120;
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + timeoutSeconds * 1000);
  const redacted = redactArguments(input.call.arguments, input.redactionFields);

  return {
    id: `appr_${safeId()}`,
    runId: input.call.runId ?? "run_unknown",
    callId: input.call.callId ?? `call_${safeId()}`,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    tool: input.call.ref.fullName,
    riskLabels: [...input.decision.riskLabels],
    policyRule: input.decision.rule,
    originalArguments: structuredClone(input.call.arguments),
    displayArguments: redacted.value,
    status: "pending",
  };
}

export async function resolveApproval(
  request: ApprovalRequest,
  reviewer: ApprovalReviewer,
  options: { now?: Date } = {},
): Promise<ApprovalResolution> {
  const now = options.now ?? new Date();
  if (now.getTime() >= Date.parse(request.expiresAt)) {
    return expire(request, now);
  }

  const remainingMs = Date.parse(request.expiresAt) - now.getTime();
  const action = await withTimeout(reviewer.review(request), remainingMs);
  const decidedAt = new Date().toISOString();

  if (!action) {
    return expire(request, new Date());
  }

  if (!action.approver.trim()) {
    return {
      status: "failed",
      decidedAt,
      originalArguments: structuredClone(request.originalArguments),
      reason: "Approval reviewer did not provide an approver identity.",
    };
  }

  switch (action.action) {
    case "approve":
      return withOptionalReason({
        status: "approved",
        approver: action.approver,
        decidedAt,
        originalArguments: structuredClone(request.originalArguments),
        finalArguments: structuredClone(request.originalArguments),
      }, action.reason);
    case "reject":
      return withOptionalReason({
        status: "rejected",
        approver: action.approver,
        decidedAt,
        originalArguments: structuredClone(request.originalArguments),
      }, action.reason);
    case "edit":
      return withOptionalReason({
        status: "edited_and_approved",
        approver: action.approver,
        decidedAt,
        originalArguments: structuredClone(request.originalArguments),
        finalArguments: structuredClone(action.editedArguments),
      }, action.reason);
  }
}

function expire(request: ApprovalRequest, now: Date): ApprovalResolution {
  return {
    status: "expired",
    decidedAt: now.toISOString(),
    originalArguments: structuredClone(request.originalArguments),
    reason: "Approval request expired before a human approved it.",
  };
}

function withOptionalReason(
  resolution: ApprovalResolution,
  reason: string | undefined,
): ApprovalResolution {
  if (reason !== undefined) {
    resolution.reason = reason;
  }

  return resolution;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function safeId(): string {
  return randomUUID().replace(/-/g, "");
}
