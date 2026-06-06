/**
 * The Warden policy template. `warden init` writes this to warden.yaml.
 *
 * Risky OpenAI Agent tool calls require approval. The default `prompt` method
 * asks you right in the terminal, so the first run works with zero setup.
 * Switch `approval.method` to `telegram` to approve from your phone, `callback`
 * to wire your own UI/Slack/on-call, or `deny` to always fail closed.
 */
export const WARDEN_POLICY = `# Warden policy for an OpenAI Agents SDK app.
# Risky tool calls pause for approval. The default \`prompt\` method asks right
# here in your terminal — no setup needed. For remote/async approval, run:
#   warden login --token <bot-token>   # then set approval.method: telegram
defaults:            # decision per risk label
  read: allow
  write: require_approval
  destructive: require_approval
  external_send: require_approval
  code_execution: require_approval
  file_mutation: require_approval
  network_egress: require_approval
  credential_access: deny
  financial: deny
  sensitive_data: require_approval
  unknown: require_approval

# Override decisions for specific tools once you see real audit data.
# Tool names are namespaced "openai.<your_tool_name>".
# tools:
#   openai.search_orders:
#     decision: allow
#   openai.send_invoice_email:
#     decision: require_approval

redaction:           # fields scrubbed from approval messages + audit logs
  fields:
    - password
    - token
    - api_key
    - secret
    - private_key
    - authorization
    - cookie
    - openai_api_key

# How approval-required actions are handled.
#   method:  prompt | telegram | callback | deny
#   timeout: 0s | 30s | 1m | 5m | 30m | 1h
approval:
  method: prompt
  timeout: 5m

audit:
  path: .warden/audit.jsonl
`;

export function wardenPolicyTemplate(): string {
  return WARDEN_POLICY;
}
