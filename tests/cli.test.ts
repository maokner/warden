import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/cli/app.js";

test("CLI init creates a policy and refuses accidental overwrite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const output = createOutput();

  try {
    const first = await runCli(["init"], { cwd: dir, ...output.io });
    const second = await runCli(["init"], { cwd: dir, ...output.io });

    assert.equal(first, 0);
    assert.equal(second, 1);
    assert.equal(existsSync(join(dir, "warden.yaml")), true);
    assert.match(readFileSync(join(dir, "warden.yaml"), "utf8"), /defaults:/);
    assert.match(output.stderr(), /already exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI policy test emits JSON decisions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const output = createOutput();

  try {
    writeFileSync(
      join(dir, "call.json"),
      JSON.stringify({
        tool: "filesystem.write_file",
        description: "Write a file",
        arguments: { path: "src/config.ts", content: "x" },
      }),
    );

    const code = await runCli(
      ["policy", "test", "call.json", "--json"],
      { cwd: dir, ...output.io },
    );
    const result = JSON.parse(output.stdout()) as {
      decision: { decision: string };
      classification: { labels: string[] };
    };

    assert.equal(code, 0);
    assert.equal(result.decision.decision, "require_approval");
    assert.deepEqual(result.classification.labels, ["write", "file_mutation"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI policy test can write an audit event and audit tail can read it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const output = createOutput();

  try {
    writeFileSync(
      join(dir, "call.json"),
      JSON.stringify({
        tool: "slack.send_message",
        description: "Send a Slack message",
        arguments: { channel: "C123", text: "hello", token: "secret" },
      }),
    );

    const policyCode = await runCli(
      ["policy", "test", "call.json", "--audit"],
      { cwd: dir, ...output.io },
    );
    assert.equal(policyCode, 0);

    const tailOutput = createOutput();
    const tailCode = await runCli(
      ["audit", "tail", "--json"],
      { cwd: dir, ...tailOutput.io },
    );

    const events = JSON.parse(tailOutput.stdout()) as Array<{
      tool: string;
      requestArguments: { token: string };
      decision: string;
    }>;

    assert.equal(tailCode, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.tool, "slack.send_message");
    assert.equal(events[0]?.decision, "deny");
    assert.equal(events[0]?.requestArguments.token, "[REDACTED]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI doctor returns monitoring_only when direct MCP exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const output = createOutput();

  try {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: { command: "github-mcp-server" },
        },
      }),
    );

    const code = await runCli(["doctor", "--json"], { cwd: dir, ...output.io });
    const report = JSON.parse(output.stdout()) as {
      status: string;
      issues: Array<{ code: string }>;
    };

    assert.equal(code, 2);
    assert.equal(report.status, "monitoring_only");
    assert.ok(report.issues.some((issue) => issue.code === "direct_mcp_server"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI setup codex prints a Warden-only MCP config snippet", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const output = createOutput();

  try {
    const code = await runCli(
      ["setup", "codex", "--config", "security/warden.yaml"],
      { cwd: dir, ...output.io },
    );

    assert.equal(code, 0);
    assert.match(output.stdout(), /\[mcp_servers\.warden\]/);
    assert.match(output.stdout(), /command = "warden"/);
    assert.match(output.stdout(), /"proxy"/);
    assert.match(output.stdout(), /security\/warden.yaml/);
    assert.doesNotMatch(output.stdout(), /\[mcp_servers\.github\]/);
    assert.equal(output.stderr(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI setup claude prints a Warden-only MCP config snippet", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const output = createOutput();

  try {
    const code = await runCli(
      ["setup", "claude", "--config", "security/warden.yaml"],
      { cwd: dir, ...output.io },
    );
    const parsed = JSON.parse(output.stdout()) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };

    assert.equal(code, 0);
    assert.deepEqual(Object.keys(parsed.mcpServers), ["warden"]);
    assert.equal(parsed.mcpServers.warden?.command, "warden");
    assert.deepEqual(parsed.mcpServers.warden?.args.slice(0, 2), [
      "proxy",
      "--config",
    ]);
    assert.equal(output.stderr(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI proxy command requires configured upstreams", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const output = createOutput();

  try {
    const code = await runCli(["proxy"], {
      cwd: dir,
      ...output.io,
    });

    assert.equal(code, 1);
    assert.match(output.stderr(), /requires at least one configured upstream/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI proxy reports missing explicit config through runCli", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const output = createOutput();

  try {
    const code = await runCli(["proxy", "--config", "missing.yaml"], {
      cwd: dir,
      ...output.io,
    });

    assert.equal(code, 1);
    assert.match(output.stderr(), /Policy config not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createOutput(): {
  io: {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
  };
  stdout: () => string;
  stderr: () => string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}
