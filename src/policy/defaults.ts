import type { DecisionType, PolicyConfig, RiskLabel } from "../domain/types.js";

export const DEFAULT_DECISIONS: Record<RiskLabel, DecisionType> = {
  read: "allow",
  write: "require_approval",
  destructive: "require_approval",
  external_send: "require_approval",
  code_execution: "require_approval",
  file_mutation: "require_approval",
  network_egress: "require_approval",
  credential_access: "deny",
  financial: "deny",
  sensitive_data: "require_approval",
  unknown: "require_approval",
};

export const DEFAULT_REDACTION_FIELDS = [
  "password",
  "token",
  "api_key",
  "apikey",
  "secret",
  "private_key",
  "authorization",
  "cookie",
];

export const DEFAULT_AUDIT_PATH = ".warden/audit.jsonl";

export function defaultPolicyConfig(): PolicyConfig {
  return {
    defaults: { ...DEFAULT_DECISIONS },
    tools: {},
    redaction: {
      fields: [...DEFAULT_REDACTION_FIELDS],
    },
    auditPath: DEFAULT_AUDIT_PATH,
    upstreams: {},
  };
}
