import { defaultPolicyConfig, guardAction, type JsonValue } from "warden";

interface Database {
  query: (sql: string) => Promise<JsonValue>;
}

const policy = defaultPolicyConfig();
policy.defaults.destructive = "deny";

export async function runChatbotSql(input: {
  db: Database;
  sql: string;
  userId: string;
}): Promise<JsonValue> {
  const result = await guardAction({
    config: policy,
    tool: "database.run_sql",
    description: "Run SQL against the production application database",
    arguments: { sql: input.sql },
    client: "website_chatbot",
    agent: "support_agent",
    user: input.userId,
    execute: async (args) => input.db.query(String(args["sql"])),
  });

  if (!result.executed) {
    throw new Error(result.error ?? "Database action blocked by Warden.");
  }

  return result.output ?? null;
}
