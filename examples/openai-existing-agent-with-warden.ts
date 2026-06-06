import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";
import { configureWarden } from "@maokner/warden";
import { guardTools } from "@maokner/warden/openai";

// Run once:
//   warden login --token <telegram-bot-token>
//   warden init --template openai
configureWarden();

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
