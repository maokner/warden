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
