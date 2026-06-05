import { createInterface, type Interface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { ApprovalAction, ApprovalReviewer } from "./approval.js";
import type { ApprovalRequest, JsonObject, JsonValue } from "../domain/types.js";

export function createTerminalReviewer(options: {
  input: Readable;
  output: Writable;
  approver: string;
}): ApprovalReviewer {
  return {
    review: async (request) => reviewInTerminal(request, options),
  };
}

async function reviewInTerminal(
  request: ApprovalRequest,
  options: {
    input: Readable;
    output: Writable;
    approver: string;
  },
): Promise<ApprovalAction> {
  const rl = createInterface({
    input: options.input,
    output: options.output,
  });

  try {
    writeSummary(options.output, request);

    while (true) {
      const answer = (
        await rl.question("Approve? [a]pprove / [r]eject / [e]dit / [d]etails: ")
      )
        .trim()
        .toLowerCase();

      if (answer === "a" || answer === "approve") {
        return { action: "approve", approver: options.approver };
      }

      if (answer === "" || answer === "r" || answer === "reject") {
        return { action: "reject", approver: options.approver };
      }

      if (answer === "d" || answer === "details") {
        options.output.write(`${JSON.stringify(request, null, 2)}\n`);
        continue;
      }

      if (answer === "e" || answer === "edit") {
        const edited = await readEditedArguments(rl, options.output);
        if (edited) {
          return {
            action: "edit",
            approver: options.approver,
            editedArguments: edited,
          };
        }
      }
    }
  } finally {
    closeReadline(rl);
  }
}

function writeSummary(output: Writable, request: ApprovalRequest): void {
  output.write("Warden approval required\n\n");
  output.write(`Tool: ${request.tool}\n`);
  output.write(`Risk: ${request.riskLabels.join(", ")}\n`);
  output.write(`Policy: ${request.policyRule}\n\n`);
  output.write("Arguments:\n");
  output.write(`${JSON.stringify(request.displayArguments, null, 2)}\n\n`);
}

async function readEditedArguments(
  rl: Interface,
  output: Writable,
): Promise<JsonObject | undefined> {
  const answer = await rl.question("Edited arguments JSON object: ");

  try {
    const parsed = JSON.parse(answer) as JsonValue;
    if (isJsonObject(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to the common validation message.
  }

  output.write("Edited arguments must be a valid JSON object.\n");
  return undefined;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closeReadline(rl: Interface): void {
  rl.close();
}
