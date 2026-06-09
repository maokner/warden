import type {
  Classification,
  DecisionType,
  JsonObject,
  PolicyConfig,
  PolicyDecision,
  RiskLabel,
  ToolPolicy,
} from "../domain/types.js";
import { matchRules } from "./rules.js";

const DECISION_SEVERITY: Record<DecisionType, number> = {
  allow: 0,
  redact_then_allow: 1,
  require_approval: 2,
  deny: 3,
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

/**
 * Precedence: a `deny` from a risk default always wins unless the tool policy
 * explicitly lists that risk in `acknowledge_risks` (which floors it at
 * `require_approval` instead). Then the tool's argument rules (first match
 * wins), then the tool decision, then the strongest risk default.
 */
export function evaluatePolicy(
  config: PolicyConfig,
  toolName: string,
  classification: Classification,
  args: JsonObject = {},
): PolicyDecision {
  const toolPolicy = config.tools[toolName];
  const riskLabels = mergeRiskLabels(classification.labels, toolPolicy);
  const acknowledged = new Set<RiskLabel>(toolPolicy?.acknowledgeRisks ?? []);
  const strongest = strongestDecisionForRisks(config, riskLabels, acknowledged);

  if (strongest.decision === "deny" && toolPolicy?.decision !== "deny") {
    return buildDecision(
      "deny",
      `defaults.${strongest.risk}`,
      `${strongest.risk} -> deny`,
      riskLabels,
      toolPolicy,
    );
  }

  if (toolPolicy?.rules) {
    const match = matchRules(toolPolicy.rules, args);
    if (match) {
      return buildDecision(
        match.rule.decision,
        `tools.${toolName}.rules[${match.index}]`,
        `Rule matched: ${match.description}.`,
        riskLabels,
        toolPolicy,
      );
    }
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
    strongest.decision,
    `defaults.${strongest.risk}`,
    strongest.acknowledgedDeny
      ? `${strongest.risk} -> require_approval (deny acknowledged by acknowledge_risks)`
      : `${strongest.risk} -> ${strongest.decision}`,
    riskLabels,
    toolPolicy,
  );
}

function strongestDecisionForRisks(
  config: PolicyConfig,
  riskLabels: RiskLabel[],
  acknowledged: Set<RiskLabel>,
): { risk: RiskLabel; decision: DecisionType; acknowledgedDeny: boolean } {
  const decisions = riskLabels.map((risk) => {
    const configured = config.defaults[risk];
    const acknowledgedDeny = configured === "deny" && acknowledged.has(risk);

    return {
      risk,
      decision: acknowledgedDeny ? ("require_approval" as DecisionType) : configured,
      acknowledgedDeny,
    };
  });

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
