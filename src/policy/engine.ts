import type {
  Classification,
  DecisionType,
  PolicyConfig,
  PolicyDecision,
  RiskLabel,
  ToolPolicy,
} from "../domain/types.js";

const DECISION_SEVERITY: Record<DecisionType, number> = {
  allow: 0,
  redact_then_allow: 1,
  transform_then_allow: 2,
  require_approval: 3,
  deny: 4,
};

const RISK_ORDER: RiskLabel[] = [
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
];

export function evaluatePolicy(
  config: PolicyConfig,
  toolName: string,
  classification: Classification,
): PolicyDecision {
  const toolPolicy = config.tools[toolName];
  const riskLabels = mergeRiskLabels(classification.labels, toolPolicy);
  const strongestRiskDecision = strongestDecisionForRisks(config, riskLabels);

  if (
    strongestRiskDecision.decision === "deny" &&
    toolPolicy?.decision !== "deny"
  ) {
    return buildDecision(
      "deny",
      `defaults.${strongestRiskDecision.risk}`,
      `${strongestRiskDecision.risk} -> deny`,
      riskLabels,
      toolPolicy,
    );
  }

  if (toolPolicy?.decision) {
    return buildDecision(
      toolPolicy.decision,
      `tools.${toolName}.decision`,
      `Tool-specific policy set decision to ${toolPolicy.decision}.`,
      riskLabels,
      toolPolicy,
    );
  }

  return buildDecision(
    strongestRiskDecision.decision,
    `defaults.${strongestRiskDecision.risk}`,
    `${strongestRiskDecision.risk} -> ${strongestRiskDecision.decision}`,
    riskLabels,
    toolPolicy,
  );
}

function strongestDecisionForRisks(
  config: PolicyConfig,
  riskLabels: RiskLabel[],
): { risk: RiskLabel; decision: DecisionType } {
  const decisions = riskLabels.map((risk) => ({
    risk,
    decision: config.defaults[risk],
  }));

  return decisions.reduce((current, next) => {
    if (DECISION_SEVERITY[next.decision] > DECISION_SEVERITY[current.decision]) {
      return next;
    }
    return current;
  });
}

function buildDecision(
  decision: DecisionType,
  rule: string,
  reason: string,
  riskLabels: RiskLabel[],
  toolPolicy: ToolPolicy | undefined,
): PolicyDecision {
  const result: PolicyDecision = {
    decision,
    reason,
    rule,
    riskLabels,
  };

  if (decision === "require_approval" && toolPolicy?.approval) {
    result.approval = toolPolicy.approval;
  }

  return result;
}

function mergeRiskLabels(
  labels: RiskLabel[],
  toolPolicy: ToolPolicy | undefined,
): RiskLabel[] {
  const merged = new Set<RiskLabel>(labels);

  for (const risk of toolPolicy?.risks ?? []) {
    merged.add(risk);
  }

  if (merged.size === 0) {
    merged.add("unknown");
  }

  return RISK_ORDER.filter((risk) => merged.has(risk));
}
