import type { ApprovalRequest, JsonObject, RiskLabel } from "../domain/types.js";
import type { ApprovalAction, ApprovalReviewer } from "./approval.js";

/** Redacted view of a pending approval — never exposes original arguments. */
export interface PendingApprovalView {
  id: string;
  tool: string;
  riskLabels: RiskLabel[];
  policyRule: string;
  createdAt: string;
  expiresAt: string;
  displayArguments: JsonObject;
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (action: ApprovalAction) => void;
  timer: NodeJS.Timeout;
}

export interface ResolveOptions {
  approver?: string;
  reason?: string;
}

/**
 * An in-memory queue of pending approvals. Implements ApprovalReviewer by
 * parking each request until a human resolves it (via approve/reject/edit) or
 * it expires. The timeout race itself lives in resolveApproval; this queue only
 * prunes its own entries when a request's window passes.
 */
export class ApprovalQueue implements ApprovalReviewer {
  private readonly pending = new Map<string, PendingApproval>();

  review(request: ApprovalRequest): Promise<ApprovalAction> {
    return new Promise<ApprovalAction>((resolve) => {
      const remainingMs = Math.max(0, Date.parse(request.expiresAt) - Date.now());
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
      }, remainingMs);
      timer.unref?.();
      this.pending.set(request.id, { request, resolve, timer });
    });
  }

  list(): PendingApprovalView[] {
    return [...this.pending.values()].map((entry) => ({
      id: entry.request.id,
      tool: entry.request.tool,
      riskLabels: [...entry.request.riskLabels],
      policyRule: entry.request.policyRule,
      createdAt: entry.request.createdAt,
      expiresAt: entry.request.expiresAt,
      displayArguments: entry.request.displayArguments,
    }));
  }

  resolve(id: string, action: ApprovalAction): boolean {
    const entry = this.pending.get(id);
    if (!entry) {
      return false;
    }
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(action);
    return true;
  }

  approve(id: string, options: ResolveOptions = {}): boolean {
    return this.settle(id, { action: "approve", approver: approver(options) }, options.reason);
  }

  reject(id: string, options: ResolveOptions = {}): boolean {
    return this.settle(id, { action: "reject", approver: approver(options) }, options.reason);
  }

  edit(id: string, editedArguments: JsonObject, options: ResolveOptions = {}): boolean {
    return this.settle(
      id,
      { action: "edit", approver: approver(options), editedArguments },
      options.reason,
    );
  }

  private settle(id: string, action: ApprovalAction, reason: string | undefined): boolean {
    if (reason) {
      action.reason = reason;
    }
    return this.resolve(id, action);
  }
}

function approver(options: ResolveOptions): string {
  return options.approver?.trim() || "local";
}
