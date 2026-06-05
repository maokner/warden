import test from "node:test";
import assert from "node:assert/strict";
import { hashPolicyConfig } from "../src/policy/hash.js";
import { defaultPolicyConfig } from "../src/policy/defaults.js";

test("hashPolicyConfig is stable for equivalent object key order", () => {
  const left = defaultPolicyConfig();
  const right = defaultPolicyConfig();

  right.tools["b.tool"] = { decision: "deny" };
  right.tools["a.tool"] = { decision: "allow" };
  left.tools["a.tool"] = { decision: "allow" };
  left.tools["b.tool"] = { decision: "deny" };

  assert.equal(hashPolicyConfig(left), hashPolicyConfig(right));
});

test("hashPolicyConfig changes when policy changes", () => {
  const left = defaultPolicyConfig();
  const right = defaultPolicyConfig();
  right.defaults.write = "deny";

  assert.notEqual(hashPolicyConfig(left), hashPolicyConfig(right));
});
