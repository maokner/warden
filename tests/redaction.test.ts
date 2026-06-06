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

test("redactArguments redacts key-value secrets even when values contain s", () => {
  const result = redactArguments(
    {
      text:
        "password=secret token=sessionvalue api_key=sk_live_value&safe=true pwd=sassy",
    },
    [],
  );

  assert.deepEqual(result.value, {
    text:
      "password=[REDACTED] token=[REDACTED] api_key=[REDACTED]&safe=true pwd=[REDACTED]",
  });
  assert.deepEqual(result.redactedPaths, ["$.text"]);
});

test("redactArguments does not corrupt existing redaction markers", () => {
  const result = redactArguments(
    {
      text: "password=[REDACTED]&safe=true token=[REDACTED]",
    },
    [],
  );

  assert.deepEqual(result.value, {
    text: "password=[REDACTED]&safe=true token=[REDACTED]",
  });
  assert.deepEqual(result.redactedPaths, []);
});
