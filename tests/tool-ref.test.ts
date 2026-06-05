import test from "node:test";
import assert from "node:assert/strict";
import { makeToolRef, parseToolRef } from "../src/domain/tool-ref.js";

test("makeToolRef creates a stable fully qualified name", () => {
  assert.deepEqual(makeToolRef("github", "create_issue"), {
    upstream: "github",
    name: "create_issue",
    fullName: "github.create_issue",
  });
});

test("parseToolRef splits only on the first dot", () => {
  assert.deepEqual(parseToolRef("postgres.public.run_query"), {
    upstream: "postgres",
    name: "public.run_query",
    fullName: "postgres.public.run_query",
  });
});

test("parseToolRef rejects malformed refs", () => {
  assert.throws(() => parseToolRef("missingdot"));
  assert.throws(() => parseToolRef(".missing_upstream"));
  assert.throws(() => parseToolRef("missing_name."));
});
