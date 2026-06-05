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
upstreams:
  filesystem:
    transport: stdio
    command: node
    args:
      - fake-server.js
    env:
      EXAMPLE_TOKEN: value
    startup_timeout_ms: 500
    tool_timeout_ms: 750
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
  assert.deepEqual(config.upstreams.filesystem, {
    transport: "stdio",
    command: "node",
    args: ["fake-server.js"],
    env: {
      EXAMPLE_TOKEN: "value",
    },
    startupTimeoutMs: 500,
    toolTimeoutMs: 750,
  });
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
});

test("parsePolicyConfig rejects unsupported upstream transports", () => {
  assert.throws(
    () =>
      parsePolicyConfig(`
upstreams:
  github:
    transport: http
    command: server
`),
    /transport must be "stdio"/,
  );
});
