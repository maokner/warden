export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export const RISK_LABELS = [
  "read",
  "write",
  "destructive",
  "external_send",
  "code_execution",
  "file_mutation",
  "network_egress",
  "credential_access",
  "financial",
  "sensitive_data",
  "unknown",
] as const;

export type RiskLabel = (typeof RISK_LABELS)[number];

export const DECISION_TYPES = [
  "allow",
  "deny",
  "require_approval",
  "redact_then_allow",
  "transform_then_allow",
] as const;

export type DecisionType = (typeof DECISION_TYPES)[number];

export type EnvironmentStatus =
  | "monitoring_only"
  | "partially_enforced"
  | "enforced";

export const APPROVAL_METHODS = ["deny", "local", "callback", "telegram"] as const;
export type ApprovalMethod = (typeof APPROVAL_METHODS)[number];

export interface GlobalApprovalConfig {
  method: ApprovalMethod;
  timeoutSeconds: number;
}

export interface ToolRef {
  upstream: string;
  name: string;
  fullName: string;
}

export interface ToolMetadata {
  ref: ToolRef;
  description: string;
  inputSchema: JsonObject;
  annotations: JsonObject;
}

export interface ToolCall {
  ref: ToolRef;
  arguments: JsonObject;
  metadata?: ToolMetadata;
  runId?: string;
  callId?: string;
  client?: string;
  agent?: string;
  user?: string;
}

export interface Classification {
  labels: RiskLabel[];
  reasons: string[];
}

export interface ApprovalPolicy {
  timeoutSeconds?: number;
  approvers?: string[];
  requireReason?: boolean;
}

export interface ToolPolicy {
  decision?: DecisionType;
  risks?: RiskLabel[];
  approval?: ApprovalPolicy;
}

export interface RedactionConfig {
  fields: string[];
}

export interface PolicyConfig {
  defaults: Record<RiskLabel, DecisionType>;
  tools: Record<string, ToolPolicy>;
  redaction: RedactionConfig;
  auditPath: string;
  upstreams: Record<string, UpstreamConfig>;
  approval: GlobalApprovalConfig;
}

export interface UpstreamConfig {
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
}

export interface PolicyDecision {
  decision: DecisionType;
  reason: string;
  rule: string;
  riskLabels: RiskLabel[];
  approval?: ApprovalPolicy;
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  callId: string;
  createdAt: string;
  expiresAt: string;
  tool: string;
  riskLabels: RiskLabel[];
  policyRule: string;
  originalArguments: JsonObject;
  displayArguments: JsonObject;
  approval?: ApprovalPolicy;
  status:
    | "pending"
    | "approved"
    | "rejected"
    | "edited_and_approved"
    | "expired"
    | "cancelled"
    | "failed";
}

export interface AuditEvent {
  id: string;
  runId: string;
  callId: string;
  timestamp: string;
  client: string;
  agent: string;
  user: string;
  upstream: string;
  tool: string;
  riskLabels: RiskLabel[];
  policyVersion: string;
  decision: DecisionType;
  policyRule: string;
  policyReason: string;
  approvalId?: string;
  requestArguments: JsonObject;
  executedArguments?: JsonObject;
  redactedPaths: string[];
  responseSummary?: string;
  responseStatus: "not_executed" | "success" | "error";
  durationMs?: number;
  error?: string;
}
