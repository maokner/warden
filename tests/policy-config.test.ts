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

test("parsePolicyConfig defaults approval to deny with a 60s timeout", () => {
  const config = parsePolicyConfig(`
defaults:
  read: allow
`);

  assert.equal(config.approval.method, "deny");
  assert.equal(config.approval.timeoutSeconds, 60);
});

test("parsePolicyConfig rejects an invalid approval method", () => {
  assert.throws(
    () => parsePolicyConfig(`approval:\n  method: email\n`),
    /approval\.method/,
  );
});
