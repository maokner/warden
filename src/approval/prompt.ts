import { createInterface } from "node:readline";
import { userInfo } from "node:os";
import type { ApprovalRequest } from "../domain/types.js";
import type { ApprovalAction, ApprovalReviewer } from "./approval.js";

export interface PromptReviewerOptions {
  /** Stream to read the approver's answer from. Defaults to process.stdin. */
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  /** Stream to print the request and prompt to. Defaults to process.stdout. */
  output?: NodeJS.WritableStream;
  /** Identity recorded as the approver. Defaults to the OS user. */
  approver?: string;
}

const MAX_ARGS_CHARS = 3500;

/**
 * Zero-setup approval: pause the agent and ask the human right here in the
 * terminal. Shows the redacted request, reads a single y/N answer, and respects
 * the request's expiry. Fails closed when no interactive TTY is attached (e.g.
 * a background or CI run), so a starter policy is safe to ship as-is.
 */
export function promptReviewer(
  options: PromptReviewerOptions = {},
): ApprovalReviewer {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const approver = options.approver ?? `terminal:${currentUser()}`;

  return {
    review: (request) =>
      new Promise<ApprovalAction>((resolve) => {
        if (!input.isTTY) {
          resolve({
            action: "reject",
            approver: "warden",
            reason:
              "Approval method is `prompt` but no interactive terminal (TTY) is attached; failing closed. Use approval.method `telegram` or `callback` for non-interactive runs.",
          });
          return;
        }

        output.write(`\n${formatRequest(request)}\n`);
        const rl = createInterface({ input, output });
        let settled = false;

        const finish = (action: ApprovalAction): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          rl.close();
          resolve(action);
        };

        const remainingMs = Math.max(0, Date.parse(request.expiresAt) - Date.now());
        const timer = setTimeout(() => {
          output.write("\n⏳ Timed out waiting for approval — denying.\n");
          finish({
            action: "reject",
            approver: "warden",
            reason: "No response at the terminal before the approval timeout.",
          });
        }, remainingMs);
        timer.unref?.();

        // EOF (Ctrl-D) or an external close resolves to a deny, never a hang.
        rl.on("close", () => {
          finish({
            action: "reject",
            approver,
            reason: "Approval prompt closed without an answer.",
          });
        });

        rl.question("Approve this action? [y/N] ", (answer) => {
          const yes = /^(y|yes)$/i.test(answer.trim());
          finish(
            yes
              ? { action: "approve", approver }
              : {
                  action: "reject",
                  approver,
                  reason: "Denied at the terminal prompt.",
                },
          );
        });
      }),
  };
}

function formatRequest(request: ApprovalRequest): string {
  const args = JSON.stringify(request.displayArguments, null, 2);
  return [
    "🛡  Warden — approval needed",
    `   Tool: ${request.tool}`,
    `   Risk: ${request.riskLabels.join(", ") || "none"}`,
    `   Rule: ${request.policyRule}`,
    "   Args:",
    indent(args.length > MAX_ARGS_CHARS ? `${args.slice(0, MAX_ARGS_CHARS)} …` : args),
  ].join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `     ${line}`)
    .join("\n");
}

function currentUser(): string {
  try {
    return userInfo().username || "local";
  } catch {
    return "local";
  }
}
