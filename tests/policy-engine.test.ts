import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy } from "../src/policy/engine.js";
import { defaultPolicyConfig } from "../src/policy/defaults.js";

test("evaluatePolicy allows read by default", () => {
  const decision = evaluatePolicy(defaultPolicyConfig(), "github.list_issues", {
    labels: ["read"],
    reasons: ["read"],
  });

  assert.equal(decision.decision, "allow");
  assert.equal(decision.rule, "defaults.read");
});

test("evaluatePolicy requires approval for writes by default", () => {
  const decision = evaluatePolicy(defaultPolicyConfig(), "filesystem.write_file", {
    labels: ["write", "file_mutation"],
    reasons: ["write"],
  });

  assert.equal(decision.decision, "require_approval");
  assert.equal(decision.rule, "defaults.write");
});

test("evaluatePolicy lets deny outrank approval", () => {
  const decision = evaluatePolicy(defaultPolicyConfig(), "stripe.create_refund", {
    labels: ["external_send", "financial"],
    reasons: ["financial"],
  });

  assert.equal(decision.decision, "deny");
  assert.equal(decision.rule, "defaults.financial");
});

test("evaluatePolicy lets tool-specific decisions override defaults", () => {
  const config = defaultPolicyConfig();
  config.tools["filesystem.write_file"] = {
    decision: "allow",
    risks: ["write", "file_mutation"],
  };

  const decision = evaluatePolicy(config, "filesystem.write_file", {
    labels: ["write", "file_mutation"],
    reasons: ["write"],
  });

  assert.equal(decision.decision, "allow");
  assert.equal(decision.rule, "tools.filesystem.write_file.decision");
  assert.deepEqual(decision.riskLabels, ["write", "file_mutation"]);
});

test("evaluatePolicy does not let non-deny tool decisions override deny risks", () => {
  const config = defaultPolicyConfig();
  config.tools["filesystem.write_file"] = {
    decision: "require_approval",
  };

  const decision = evaluatePolicy(config, "filesystem.write_file", {
    labels: ["write", "credential_access", "sensitive_data"],
    reasons: ["credential"],
  });

  assert.equal(decision.decision, "deny");
  assert.equal(decision.rule, "defaults.credential_access");
});

test("evaluatePolicy merges configured risk overrides", () => {
  const config = defaultPolicyConfig();
  config.tools["internal.export_report"] = {
    risks: ["sensitive_data"],
  };

  const decision = evaluatePolicy(config, "internal.export_report", {
    labels: ["read"],
    reasons: ["read"],
  });

  assert.equal(decision.decision, "require_approval");
  assert.deepEqual(decision.riskLabels, ["read", "sensitive_data"]);
});

test("evaluatePolicy fails closed for unknown tools", () => {
  const decision = evaluatePolicy(defaultPolicyConfig(), "custom.do_thing", {
    labels: ["unknown"],
    reasons: ["unknown"],
  });

  assert.equal(decision.decision, "require_approval");
  assert.equal(decision.rule, "defaults.unknown");
});

test("evaluatePolicy floors an acknowledged deny risk at require_approval", () => {
  const config = defaultPolicyConfig();
  config.tools["stripe.issue_refund"] = { acknowledgeRisks: ["financial"] };

  const decision = evaluatePolicy(config, "stripe.issue_refund", {
    labels: ["financial"],
    reasons: ["financial"],
  });

  assert.equal(decision.decision, "require_approval");
  assert.equal(decision.rule, "defaults.financial");
  assert.match(decision.reason, /acknowledged/);
});

test("evaluatePolicy lets an acknowledged tool apply its own decision", () => {
  const config = defaultPolicyConfig();
  config.tools["stripe.issue_refund"] = {
    acknowledgeRisks: ["financial"],
    decision: "require_approval",
  };

  const decision = evaluatePolicy(config, "stripe.issue_refund", {
    labels: ["financial", "external_send"],
    reasons: ["financial"],
  });

  assert.equal(decision.decision, "require_approval");
  assert.equal(decision.rule, "tools.stripe.issue_refund.decision");
});

test("evaluatePolicy keeps deny for risks the tool did not acknowledge", () => {
  const config = defaultPolicyConfig();
  config.tools["stripe.issue_refund"] = {
    acknowledgeRisks: ["financial"],
    decision: "require_approval",
  };

  const decision = evaluatePolicy(config, "stripe.issue_refund", {
    labels: ["financial", "credential_access"],
    reasons: ["financial", "credential"],
  });

  assert.equal(decision.decision, "deny");
  assert.equal(decision.rule, "defaults.credential_access");
});

test("evaluatePolicy applies the first matching argument rule", () => {
  const config = defaultPolicyConfig();
  config.tools["billing.update_plan"] = {
    decision: "require_approval",
    rules: [
      { when: { amount: { lte: 50 } }, decision: "allow" },
      { when: { amount: { gt: 500 } }, decision: "deny" },
    ],
  };
  const classification = { labels: ["write"] as const, reasons: ["write"] };

  const small = evaluatePolicy(config, "billing.update_plan", {
    labels: [...classification.labels],
    reasons: classification.reasons,
  }, { amount: 25 });
  assert.equal(small.decision, "allow");
  assert.equal(small.rule, "tools.billing.update_plan.rules[0]");
  assert.match(small.reason, /arguments\.amount <= 50/);

  const large = evaluatePolicy(config, "billing.update_plan", {
    labels: [...classification.labels],
    reasons: classification.reasons,
  }, { amount: 900 });
  assert.equal(large.decision, "deny");
  assert.equal(large.rule, "tools.billing.update_plan.rules[1]");

  const middle = evaluatePolicy(config, "billing.update_plan", {
    labels: [...classification.labels],
    reasons: classification.reasons,
  }, { amount: 100 });
  assert.equal(middle.decision, "require_approval");
  assert.equal(middle.rule, "tools.billing.update_plan.decision");
});

test("evaluatePolicy never lets a rule weaken an unacknowledged deny", () => {
  const config = defaultPolicyConfig();
  config.tools["stripe.issue_refund"] = {
    rules: [{ when: { amount: { lte: 50 } }, decision: "allow" }],
  };

  const decision = evaluatePolicy(
    config,
    "stripe.issue_refund",
    { labels: ["financial"], reasons: ["financial"] },
    { amount: 25 },
  );

  assert.equal(decision.decision, "deny");
  assert.equal(decision.rule, "defaults.financial");
});

test("evaluatePolicy attaches the tool approval policy to rule decisions", () => {
  const config = defaultPolicyConfig();
  config.tools["billing.update_plan"] = {
    decision: "allow",
    approval: { approvers: ["alice"] },
    rules: [{ when: { amount: { gt: 500 } }, decision: "require_approval" }],
  };

  const decision = evaluatePolicy(
    config,
    "billing.update_plan",
    { labels: ["write"], reasons: ["write"] },
    { amount: 900 },
  );

  assert.equal(decision.decision, "require_approval");
  assert.deepEqual(decision.approval, { approvers: ["alice"] });
});
