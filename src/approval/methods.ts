import type { ApprovalRequest, JsonObject } from "../domain/types.js";
import type { ApprovalAction, ApprovalReviewer } from "./approval.js";

export const TIMEOUT_PRESETS: Record<string, number> = {
  none: 0,
  "30s": 30,
  "1m": 60,
  "5m": 300,
  "30m": 1800,
  "1h": 3600,
};

export const TIMEOUT_PRESET_NAMES = Object.keys(TIMEOUT_PRESETS);

/**
 * Accepts a preset name (none/30s/1m/5m/30m/1h) or a non-negative integer
 * number of seconds. Returns seconds.
 */
export function parseTimeout(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error("approval timeout must be a non-negative integer.");
    }
    return value;
  }

  const trimmed = value.trim().toLowerCase();
  if (trimmed in TIMEOUT_PRESETS) {
    return TIMEOUT_PRESETS[trimmed] as number;
  }

  const seconds = Number(trimmed);
  if (!Number.isInteger(seconds) || seconds < 0) {
    throw new Error(
      `approval timeout must be one of ${TIMEOUT_PRESET_NAMES.join(", ")} or a non-negative integer of seconds.`,
    );
  }
  return seconds;
}

export interface ApprovalDecision {
  decision: "approve" | "reject" | "edit";
  approver?: string;
  reason?: string;
  editedArguments?: JsonObject;
}

export type ApprovalCallback = (
  request: ApprovalRequest,
) => Promise<ApprovalDecision> | ApprovalDecision;

/** A reviewer that never approves — used for the `deny` approval method. */
export function denyReviewer(): ApprovalReviewer {
  return {
    review: async () => ({
      action: "reject",
      approver: "warden",
      reason: "Approval method is `deny`; no human approval channel is configured.",
    }),
  };
}

/** Wraps a user-supplied callback into the reviewer interface. */
export function callbackReviewer(callback: ApprovalCallback): ApprovalReviewer {
  return {
    review: async (request) => toAction(await callback(request)),
  };
}

function toAction(decision: ApprovalDecision): ApprovalAction {
  const approver = decision.approver?.trim() || "callback";

  switch (decision.decision) {
    case "approve":
      return withReason({ action: "approve", approver }, decision.reason);
    case "reject":
      return withReason({ action: "reject", approver }, decision.reason);
    case "edit":
      return withReason(
        {
          action: "edit",
          approver,
          editedArguments: decision.editedArguments ?? {},
        },
        decision.reason,
      );
  }
}

function withReason(action: ApprovalAction, reason: string | undefined): ApprovalAction {
  if (reason !== undefined) {
    return { ...action, reason };
  }
  return action;
}
