import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";
import { configureWarden } from "@maokner/warden";
import { guardTools } from "@maokner/warden/openai";

// A brand-new guarded agent. `warden init` scaffolds this exact file.
// Run once (no bot or backend needed — approvals happen in your terminal):
//   warden init
//   export OPENAI_API_KEY=sk-...
//   npx tsx examples/openai-from-scratch.ts

// Loads warden.yaml + approval settings. Call once at startup.
configureWarden();

// Your real side-effecting client goes here (email, billing, CRM, database...).
// This stub stands in for one so the starter runs as-is.
const emailClient = {
  send: async (input: { to: string; template: string; discountCode: string }) => ({
    id: "email_123",
    ...input,
  }),
};

// Define tools as plain objects, wrap the WHOLE array with guardTools() so
// coverage stays automatic as you add tools, then .map(tool) for the SDK.
const rawTools = [
  {
    name: "send_discount_email",
    description: "Send a discount email to a customer",
    parameters: z.object({
      customerEmail: z.string(),
      discountCode: z.string(),
    }),
    execute: async ({ customerEmail, discountCode }) =>
      emailClient.send({ to: customerEmail, template: "discount", discountCode }),
  },
];

const tools = guardTools(rawTools).map(tool);

const agent = new Agent({
  name: "Support agent",
  instructions: "Help customers with account and billing requests.",
  tools,
});

// Sending an email is classified as external_send, which requires approval.
// With the default approval.method: prompt, this pauses and asks you to approve
// right here in the terminal — switch to telegram to approve from your phone.
const result = await run(agent, "Send Taylor a discount code.");
console.log(result.finalOutput);
