import test from "node:test";
import assert from "node:assert/strict";
import { parsePolicyConfig } from "../src/policy/config.js";

test("parsePolicyConfig merges user config with secure defaults", () => {
  const config = parsePolicyConfig(`
defaults:
  write: deny
tools:
  filesystem.write_file:
    decision: require_approval
    risks:
      - write
      - file_mutation
    approval:
      timeout_seconds: 90
      approvers:
        - local_user
      require_reason: true
redaction:
  fields:
    - password
audit:
  path: .warden/custom.jsonl
`);

  assert.equal(config.defaults.read, "allow");
  assert.equal(config.defaults.write, "deny");
  assert.equal(config.tools["filesystem.write_file"]?.decision, "require_approval");
  assert.deepEqual(config.tools["filesystem.write_file"]?.risks, [
    "write",
    "file_mutation",
  ]);
  assert.deepEqual(config.tools["filesystem.write_file"]?.approval, {
    timeoutSeconds: 90,
    approvers: ["local_user"],
    requireReason: true,
  });
  assert.ok(config.redaction.fields.includes("password"));
  assert.ok(config.redaction.fields.includes("private_key"));
  assert.ok(config.redaction.fields.includes("authorization"));
  assert.equal(config.auditPath, ".warden/custom.jsonl");
});

test("parsePolicyConfig rejects invalid risk labels", () => {
  assert.throws(
    () =>
      parsePolicyConfig(`
defaults:
  impossible: allow
`),
    /valid risk label/,
  );
});

test("parsePolicyConfig rejects invalid decisions", () => {
  assert.throws(
    () =>
      parsePolicyConfig(`
defaults:
  write: maybe
`),
    /must be one of/,
  );
});

test("parsePolicyConfig rejects malformed approval timeouts", () => {
  assert.throws(
    () =>
      parsePolicyConfig(`
tools:
  github.merge_pull_request:
    decision: require_approval
    approval:
      timeout_seconds: 0
`),
    /positive integer/,
  );
  assert.throws(
    () =>
      parsePolicyConfig(`
approval:
  timeout: none
`),
    /approval timeout/,
  );
});

test("parsePolicyConfig parses the approval block with presets", () => {
  const config = parsePolicyConfig(`
approval:
  method: callback
  timeout: 5m
`);

  assert.equal(config.approval.method, "callback");
  assert.equal(config.approval.timeoutSeconds, 300);
});

test("parsePolicyConfig defaults approval to the documented prompt method and 5m timeout", () => {
  const config = parsePolicyConfig(`
defaults:
  read: allow
`);

  assert.equal(config.approval.method, "prompt");
  assert.equal(config.approval.timeoutSeconds, 300);
});

test("parsePolicyConfig rejects an invalid approval method", () => {
  assert.throws(
    () => parsePolicyConfig(`approval:\n  method: email\n`),
    /approval\.method/,
  );
});

test("parsePolicyConfig rejects unknown keys instead of ignoring them", () => {
  assert.throws(
    () => parsePolicyConfig(`upstreams:\n  foo: bar\n`),
    /policy config has unknown key.*upstreams/,
  );
  assert.throws(
    () => parsePolicyConfig(`approval:\n  metod: prompt\n`),
    /approval has unknown key.*metod/,
  );
  assert.throws(
    () =>
      parsePolicyConfig(`
tools:
  openai.do_thing:
    decison: allow
`),
    /tools\.openai\.do_thing has unknown key.*decison/,
  );
});

test("parsePolicyConfig parses acknowledge_risks", () => {
  const config = parsePolicyConfig(`
tools:
  openai.issue_refund:
    acknowledge_risks: [financial]
    decision: require_approval
`);

  assert.deepEqual(config.tools["openai.issue_refund"]?.acknowledgeRisks, [
    "financial",
  ]);

  assert.throws(
    () =>
      parsePolicyConfig(`
tools:
  openai.issue_refund:
    acknowledge_risks: [imaginary]
`),
    /valid risk label/,
  );
});

test("parsePolicyConfig parses argument rules with matchers and shorthand", () => {
  const config = parsePolicyConfig(`
tools:
  openai.issue_refund:
    decision: require_approval
    rules:
      - when:
          amount: { lte: 50 }
          currency: usd
        decision: allow
      - when:
          customer.email: { matches: "@example\\\\.com$" }
        decision: require_approval
`);

  const rules = config.tools["openai.issue_refund"]?.rules;
  assert.equal(rules?.length, 2);
  assert.deepEqual(rules?.[0], {
    when: { amount: { lte: 50 }, currency: { eq: "usd" } },
    decision: "allow",
  });
  assert.deepEqual(rules?.[1], {
    when: { "customer.email": { matches: "@example\\.com$" } },
    decision: "require_approval",
  });
});

test("parsePolicyConfig rejects malformed rules", () => {
  assert.throws(
    () =>
      parsePolicyConfig(`
tools:
  openai.t:
    rules:
      - decision: allow
`),
    /when is required/,
  );
  assert.throws(
    () =>
      parsePolicyConfig(`
tools:
  openai.t:
    rules:
      - when: {}
        decision: allow
`),
    /at least one condition/,
  );
  assert.throws(
    () =>
      parsePolicyConfig(`
tools:
  openai.t:
    rules:
      - when:
          amount: { gt: high }
        decision: allow
`),
    /gt must be a finite number/,
  );
  assert.throws(
    () =>
      parsePolicyConfig(`
tools:
  openai.t:
    rules:
      - when:
          amount: { near: 50 }
        decision: allow
`),
    /unknown key.*near/,
  );
  assert.throws(
    () =>
      parsePolicyConfig(`
tools:
  openai.t:
    rules:
      - when:
          note: { matches: "(" }
        decision: allow
`),
    /not a valid regular expression/,
  );
});
