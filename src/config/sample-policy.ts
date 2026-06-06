export const SAMPLE_POLICY = `defaults:
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

tools:
  filesystem.read_file:
    decision: allow
  filesystem.write_file:
    decision: require_approval
  filesystem.delete_file:
    decision: deny

redaction:
  fields:
    - password
    - token
    - api_key
    - secret
    - private_key
    - authorization
    - cookie

# How approval-required actions are handled.
#   method:  deny | local | callback | telegram
#   timeout: none | 30s | 1m | 5m | 30m | 1h
approval:
  method: deny
  timeout: 1m

audit:
  path: .warden/audit.jsonl
`;

export const DATABASE_POLICY = `# Database-focused Warden policy.
# Keep the policy and audit path outside an agent-writable workspace for hardened use.
defaults:
  read: allow
  write: require_approval
  destructive: deny
  external_send: deny
  code_execution: deny
  file_mutation: deny
  network_egress: deny
  credential_access: deny
  financial: deny
  sensitive_data: require_approval
  unknown: require_approval

tools:
  # Replace or extend these names with exact tool names from "warden inspect".
  postgres.query:
    approval:
      require_reason: true
  postgres.execute:
    approval:
      require_reason: true
  postgres.run_query:
    approval:
      require_reason: true
  mysql.query:
    approval:
      require_reason: true
  mysql.execute:
    approval:
      require_reason: true
  sqlite.query:
    approval:
      require_reason: true
  sqlite.execute:
    approval:
      require_reason: true

redaction:
  fields:
    - password
    - token
    - api_key
    - secret
    - private_key
    - authorization
    - cookie
    - database_url
    - connection_string
    - dsn
    - pgpassword
    - mysql_pwd
    - uri

# How approval-required actions are handled.
#   method:  deny | local | callback | telegram
#   timeout: none | 30s | 1m | 5m | 30m | 1h
approval:
  method: local
  timeout: 5m

audit:
  path: .warden/audit.jsonl
`;

export const POLICY_TEMPLATES = {
  default: SAMPLE_POLICY,
  database: DATABASE_POLICY,
} as const;

export type PolicyTemplateName = keyof typeof POLICY_TEMPLATES;

export function policyTemplateNames(): PolicyTemplateName[] {
  return Object.keys(POLICY_TEMPLATES) as PolicyTemplateName[];
}

export function policyTemplate(name: string): string {
  if (!isPolicyTemplateName(name)) {
    throw new Error(
      `Unknown policy template "${name}". Available templates: ${policyTemplateNames().join(", ")}.`,
    );
  }

  return POLICY_TEMPLATES[name];
}

function isPolicyTemplateName(name: string): name is PolicyTemplateName {
  return Object.hasOwn(POLICY_TEMPLATES, name);
}
