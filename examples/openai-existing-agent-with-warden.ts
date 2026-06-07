import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";
import { configureWarden } from "@maokner/warden";
import { guardTools } from "@maokner/warden/openai";

// Run once:
//   warden init --policy-only        # approvals default to a terminal prompt
// For phone approval instead, also run:
//   warden login --token <bot-token> # then set approval.method: telegram
configureWarden();

// Already have an array of tool(...) results? Skip the raw-array rewrite below
// and wrap it directly — guardTools() accepts constructed tools too:
//   const agent = new Agent({ name: "support", tools: guardTools(existingTools) });

const emailClient = {
  send: async (input: {
    to: string;
    template: string;
    discountCode: string;
  }) => ({ id: "email_123", ...input }),
};

const rawTools = [
  {
    name: "send_discount_email",
    description: "Send a discount email to a customer",
    parameters: z.object({
      customerEmail: z.string(),
      discountCode: z.string(),
    }),
    execute: async ({ customerEmail, discountCode }) => {
      return emailClient.send({
        to: customerEmail,
        template: "discount",
        discountCode,
      });
    },
  },
];

const tools = guardTools(rawTools).map(tool);

const agent = new Agent({
  name: "Support agent",
  instructions: "Help customers with account and billing requests.",
  tools,
});

const result = await run(agent, "Send Taylor a discount code.");
console.log(result.finalOutput);
