/**
 * The Warden policy template. `warden init` writes this to warden.yaml.
 *
 * Risky OpenAI Agent tool calls require approval; by default they DM a linked
 * Telegram approver. Switch `approval.method` to `callback` to wire your own
 * verification in code, or `deny` to fail closed with zero setup.
 */
export const WARDEN_POLICY = `# Warden policy for an OpenAI Agents SDK app.
# Pair a Telegram approver once with:
#   warden login --token <bot-token>
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
#   method:  deny | callback | telegram
#   timeout: 0s | 30s | 1m | 5m | 30m | 1h
approval:
  method: telegram
  timeout: 5m

audit:
  path: .warden/audit.jsonl
`;

export function wardenPolicyTemplate(): string {
  return WARDEN_POLICY;
}
