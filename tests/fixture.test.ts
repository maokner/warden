import test from "node:test";
import assert from "node:assert/strict";
import { normalizeToolCallFixture } from "../src/tool-call/fixture.js";

test("normalizeToolCallFixture builds metadata from fixture shape", () => {
  const call = normalizeToolCallFixture({
    tool: "filesystem.write_file",
    description: "Write a file",
    arguments: { path: "README.md", content: "hello" },
    client: "codex",
  });

  assert.equal(call.ref.fullName, "filesystem.write_file");
  assert.equal(call.metadata?.description, "Write a file");
  assert.deepEqual(call.arguments, { path: "README.md", content: "hello" });
  assert.equal(call.client, "codex");
});

test("normalizeToolCallFixture rejects missing tool names", () => {
  assert.throws(
    () => normalizeToolCallFixture({ arguments: {} }),
    /tool must be a non-empty string/,
  );
});

test("normalizeToolCallFixture rejects non-object arguments", () => {
  assert.throws(
    () => normalizeToolCallFixture({ tool: "x.y", arguments: "bad" }),
    /arguments must be an object/,
  );
});
