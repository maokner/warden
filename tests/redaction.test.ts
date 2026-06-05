import test from "node:test";
import assert from "node:assert/strict";
import { redactArguments } from "../src/policy/redaction.js";

test("redactArguments redacts nested sensitive fields", () => {
  const input = {
    username: "alice",
    password: "pw",
    nested: {
      githubToken: "ghp_123",
      keep: "visible",
    },
    list: [{ api_key: "secret" }, { value: "ok" }],
  };

  const result = redactArguments(input, ["password", "token", "api_key"]);

  assert.deepEqual(result.value, {
    username: "alice",
    password: "[REDACTED]",
    nested: {
      githubToken: "[REDACTED]",
      keep: "visible",
    },
    list: [{ api_key: "[REDACTED]" }, { value: "ok" }],
  });
  assert.deepEqual(result.redactedPaths, [
    "$.password",
    "$.nested.githubToken",
    "$.list[0].api_key",
  ]);
});

test("redactArguments does not mutate the original object", () => {
  const input = {
    token: "secret",
    nested: {
      api_key: "secret",
    },
  };

  redactArguments(input, ["token", "api_key"]);

  assert.deepEqual(input, {
    token: "secret",
    nested: {
      api_key: "secret",
    },
  });
});

test("redactArguments redacts secret-looking substrings inside string values", () => {
  const result = redactArguments(
    {
      content:
        "Authorization: Bearer abcdefghijklmnop and url=https://u:p455w0rdabc@example.com",
      note: "password=hunter2&safe=true",
    },
    [],
  );

  assert.deepEqual(result.value, {
    content:
      "Authorization: [REDACTED] and url=https://[REDACTED]example.com",
    note: "password=[REDACTED]&safe=true",
  });
  assert.deepEqual(result.redactedPaths, ["$.content", "$.note"]);
});
