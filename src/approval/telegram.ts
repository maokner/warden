import type { ApprovalRequest } from "../domain/types.js";
import type {
  TelegramClient,
  TelegramPollAnswer,
} from "../telegram/client.js";
import type { ApprovalAction, ApprovalReviewer } from "./approval.js";

export interface TelegramApprovalChannelOptions {
  client: TelegramClient;
  chatId: number;
  /** Long-poll timeout passed to getUpdates. */
  pollTimeoutSeconds?: number;
}

interface Pending {
  resolve: (action: ApprovalAction) => void;
  messageId: number;
  timer: NodeJS.Timeout;
}

const APPROVE_OPTION = 0;
const MAX_ARGS_CHARS = 3500;

/**
 * Sends each approval-required call to a Telegram approver as a poll and
 * resolves it from the bot's long-poll stream. First vote wins; the poll is
 * closed on resolution or expiry. Implements ApprovalReviewer, so the timeout
 * race and fail-closed behavior live in resolveApproval.
 */
export class TelegramApprovalChannel implements ApprovalReviewer {
  private readonly client: TelegramClient;
  private readonly chatId: number;
  private readonly pollTimeoutSeconds: number;
  private readonly pending = new Map<string, Pending>();
  private running = false;
  private offset: number | undefined;
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;

  constructor(options: TelegramApprovalChannelOptions) {
    this.client = options.client;
    this.chatId = options.chatId;
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 30;
  }

  async review(request: ApprovalRequest): Promise<ApprovalAction> {
    await this.client.sendMessage(this.chatId, formatRequest(request));
    const { messageId, pollId } = await this.client.sendPoll(
      this.chatId,
      "Approve this action?",
      ["✅ Approve", "❌ Deny"],
    );

    return new Promise<ApprovalAction>((resolve) => {
      const remainingMs = Math.max(0, Date.parse(request.expiresAt) - Date.now());
      const timer = setTimeout(() => {
        if (this.pending.delete(pollId)) {
          void this.client.stopPoll(this.chatId, messageId).catch(() => undefined);
        }
      }, remainingMs);
      timer.unref?.();
      this.pending.set(pollId, { resolve, messageId, timer });
    });
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.controller?.abort();
    try {
      await this.loop;
    } catch {
      // loop exits via the running flag
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      // Never leave a caller hanging on an unresolved review.
      pending.resolve({
        action: "reject",
        approver: "warden",
        reason: "Approval channel stopped before a decision arrived.",
      });
    }
    this.pending.clear();
  }

  private async runLoop(): Promise<void> {
    // getUpdates conflicts (HTTP 409) with a configured webhook; clear any
    // leftover webhook so a reused bot doesn't silently time out every poll.
    await this.client.deleteWebhook().catch(() => undefined);

    while (this.running) {
      this.controller = new AbortController();
      let updates;
      try {
        updates = await this.client.getUpdates({
          offset: this.offset,
          timeoutSeconds: this.pollTimeoutSeconds,
          signal: this.controller.signal,
        });
      } catch {
        if (!this.running) {
          return;
        }
        await delay(500);
        continue;
      }

      for (const update of updates) {
        this.offset = update.update_id + 1;
        if (update.poll_answer) {
          this.handleAnswer(update.poll_answer);
        }
      }
    }
  }

  private handleAnswer(answer: TelegramPollAnswer): void {
    const pending = this.pending.get(answer.poll_id);
    if (!pending) {
      return;
    }

    // A positive chat id is a private chat with the paired approver — ignore
    // votes that don't come from that account (and votes with no user at all).
    if (this.chatId > 0 && answer.user?.id !== this.chatId) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(answer.poll_id);

    const approver = `telegram:${answer.user?.username ?? answer.user?.id ?? "unknown"}`;
    const approved = answer.option_ids[0] === APPROVE_OPTION;
    void this.client.stopPoll(this.chatId, pending.messageId).catch(() => undefined);
    pending.resolve(
      approved
        ? { action: "approve", approver }
        : { action: "reject", approver },
    );
  }
}

function formatRequest(request: ApprovalRequest): string {
  const args = JSON.stringify(request.displayArguments, null, 2);
  return [
    "🛡 Warden — approval needed",
    `Tool: ${request.tool}`,
    `Risk: ${request.riskLabels.join(", ") || "none"}`,
    `Rule: ${request.policyRule}`,
    "Args:",
    args.length > MAX_ARGS_CHARS ? `${args.slice(0, MAX_ARGS_CHARS)} …` : args,
  ].join("\n");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
