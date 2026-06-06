import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";

// Existing app service. In a real app this is your current email, CRM, billing,
// ticketing, or workflow client.
const emailClient = {
  send: async (input: {
    to: string;
    template: string;
    discountCode: string;
  }) => ({ id: "email_123", ...input }),
};

const tools = [
  tool({
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
  }),
];

const agent = new Agent({
  name: "Support agent",
  instructions: "Help customers with account and billing requests.",
  tools,
});

const result = await run(agent, "Send Taylor a discount code.");
console.log(result.finalOutput);
