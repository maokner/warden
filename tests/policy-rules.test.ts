import test from "node:test";
import assert from "node:assert/strict";
import { describeRule, matchRules, resolveArgumentPath } from "../src/policy/rules.js";
import type { ToolRule } from "../src/domain/types.js";

function rule(when: ToolRule["when"]): ToolRule[] {
  return [{ when, decision: "allow" }];
}

test("matchRules compares numbers with gt/gte/lt/lte", () => {
  assert.ok(matchRules(rule({ amount: { lte: 50 } }), { amount: 50 }));
  assert.ok(matchRules(rule({ amount: { lt: 50 } }), { amount: 49 }));
  assert.ok(matchRules(rule({ amount: { gte: 50 } }), { amount: 50 }));
  assert.ok(matchRules(rule({ amount: { gt: 50 } }), { amount: 51 }));
  assert.equal(matchRules(rule({ amount: { gt: 50 } }), { amount: 50 }), undefined);
});

test("matchRules coerces numeric strings for numeric comparators", () => {
  assert.ok(matchRules(rule({ amount: { gt: 500 } }), { amount: "900" }));
  assert.equal(
    matchRules(rule({ amount: { gt: 500 } }), { amount: "not-a-number" }),
    undefined,
  );
});

test("matchRules treats a scalar shorthand as eq and keeps eq strict", () => {
  assert.ok(matchRules(rule({ currency: { eq: "usd" } }), { currency: "usd" }));
  assert.equal(matchRules(rule({ currency: { eq: "usd" } }), { currency: "USD" }), undefined);
  assert.equal(matchRules(rule({ amount: { eq: 50 } }), { amount: "50" }), undefined);
});

test("matchRules requires presence for ne", () => {
  assert.ok(matchRules(rule({ currency: { ne: "usd" } }), { currency: "eur" }));
  assert.equal(matchRules(rule({ currency: { ne: "usd" } }), { currency: "usd" }), undefined);
  assert.equal(matchRules(rule({ currency: { ne: "usd" } }), {}), undefined);
});

test("matchRules supports in, contains, and matches", () => {
  assert.ok(matchRules(rule({ currency: { in: ["usd", "eur"] } }), { currency: "eur" }));
  assert.equal(matchRules(rule({ currency: { in: ["usd"] } }), { currency: "gbp" }), undefined);

  assert.ok(matchRules(rule({ note: { contains: "urgent" } }), { note: "very urgent case" }));
  assert.ok(matchRules(rule({ tags: { contains: "vip" } }), { tags: ["vip", "eu"] }));
  assert.equal(matchRules(rule({ tags: { contains: "vip" } }), { tags: ["basic"] }), undefined);

  assert.ok(
    matchRules(rule({ to: { matches: "@example\\.com$" } }), { to: "a@example.com" }),
  );
  assert.equal(
    matchRules(rule({ to: { matches: "@example\\.com$" } }), { to: "a@evil.com" }),
    undefined,
  );
});

test("matchRules handles exists in both directions", () => {
  assert.ok(matchRules(rule({ reason: { exists: true } }), { reason: "x" }));
  assert.equal(matchRules(rule({ reason: { exists: true } }), {}), undefined);
  assert.ok(matchRules(rule({ dryRun: { exists: false } }), {}));
  assert.equal(matchRules(rule({ dryRun: { exists: false } }), { dryRun: true }), undefined);
});

test("matchRules never fires non-exists matchers on missing arguments", () => {
  assert.equal(matchRules(rule({ amount: { lte: 50 } }), {}), undefined);
  assert.equal(matchRules(rule({ note: { contains: "x" } }), {}), undefined);
  assert.equal(matchRules(rule({ note: { matches: "x" } }), {}), undefined);
});

test("matchRules ANDs all conditions in a rule and returns the first match", () => {
  const rules: ToolRule[] = [
    { when: { amount: { lte: 50 }, currency: { eq: "usd" } }, decision: "allow" },
    { when: { amount: { lte: 50 } }, decision: "require_approval" },
  ];

  const eur = matchRules(rules, { amount: 10, currency: "eur" });
  assert.equal(eur?.index, 1);

  const usd = matchRules(rules, { amount: 10, currency: "usd" });
  assert.equal(usd?.index, 0);
});

test("resolveArgumentPath walks nested objects only", () => {
  const args = { customer: { email: "a@b.com" }, items: [{ sku: "x" }] };

  assert.equal(resolveArgumentPath(args, "customer.email"), "a@b.com");
  assert.equal(resolveArgumentPath(args, "customer.missing"), undefined);
  assert.equal(resolveArgumentPath(args, "items.0.sku"), undefined);
});

test("describeRule renders a readable condition string", () => {
  const description = describeRule({
    when: { amount: { gt: 500 }, currency: { in: ["usd", "eur"] } },
    decision: "deny",
  });

  assert.equal(
    description,
    'arguments.amount > 500 and arguments.currency in ["usd", "eur"]',
  );
});
