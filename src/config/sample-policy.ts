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

audit:
  path: .warden/audit.jsonl
`;
