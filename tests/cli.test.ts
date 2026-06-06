import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/cli/app.js";
import { createApprovalRequest, resolveApproval } from "../src/approval/approval.js";
import { ApprovalQueue } from "../src/approval/queue.js";
import { createApprovalServer } from "../src/approval/server.js";
import { makeToolRef } from "../src/domain/tool-ref.js";
import { startFakeTelegram } from "./fixtures/fake-telegram.js";

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

test("CLI init can create the database policy template", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const output = createOutput();

  try {
    const code = await runCli(
      ["init", "--template", "database"],
      { cwd: dir, ...output.io },
    );
    const policy = readFileSync(join(dir, "warden.yaml"), "utf8");

    assert.equal(code, 0);
    assert.match(policy, /Database-focused Warden policy/);
    assert.match(policy, /destructive: deny/);
    assert.match(policy, /postgres\.query/);
    assert.match(output.stdout(), /database template/);
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

test("CLI inspect emits upstream tool inventory as JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const output = createOutput();

  try {
    writeFakeUpstreamConfig(dir);

    const code = await runCli(
      ["inspect", "--config", "warden.yaml", "--json"],
      { cwd: dir, ...output.io },
    );
    const result = JSON.parse(output.stdout()) as {
      tools: Array<{
        name: string;
        upstream: string;
        upstreamTool: string;
        riskLabels: string[];
        decision: string;
        policyRule: string;
      }>;
    };

    assert.equal(code, 0);
    assert.deepEqual(
      result.tools.map((tool) => tool.name),
      ["fixture.read_echo", "fixture.write_echo"],
    );
    assert.equal(result.tools[0]?.name, "fixture.read_echo");
    assert.equal(result.tools[0]?.upstream, "fixture");
    assert.equal(result.tools[0]?.upstreamTool, "read_echo");
    assert.deepEqual(result.tools[0]?.riskLabels, ["read"]);
    assert.equal(result.tools[0]?.decision, "allow");
    assert.equal(result.tools[0]?.policyRule, "defaults.read");
    assert.equal(result.tools[1]?.decision, "require_approval");
    assert.deepEqual(result.tools[1]?.riskLabels, ["write"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI inspect emits readable text inventory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const output = createOutput();

  try {
    writeFakeUpstreamConfig(dir);

    const code = await runCli(
      ["inspect", "--config", "warden.yaml"],
      { cwd: dir, ...output.io },
    );

    assert.equal(code, 0);
    assert.match(output.stdout(), /fixture\.read_echo/);
    assert.match(output.stdout(), /decision: allow/);
    assert.match(output.stdout(), /fixture\.write_echo/);
    assert.match(output.stdout(), /decision: require_approval/);
    assert.equal(output.stderr(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI inspect command requires configured upstreams", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const output = createOutput();

  try {
    const code = await runCli(["inspect"], {
      cwd: dir,
      ...output.io,
    });

    assert.equal(code, 1);
    assert.match(output.stderr(), /requires at least one configured upstream/);
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

test("CLI exec launches with protected env scrubbed and Warden-only temp config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const output = createOutput();
  const previousOpenAiKey = process.env["OPENAI_API_KEY"];
  const previousDatabaseUrl = process.env["DATABASE_URL"];

  try {
    process.env["OPENAI_API_KEY"] = "sk-test";
    process.env["DATABASE_URL"] = "postgres://user:pass@example/db";
    writeFileSync(join(dir, "warden.yaml"), "defaults: {}\n");

    const script = [
      "const fs = require('node:fs');",
      "const configPath = process.env.CODEX_HOME + '/config.toml';",
      "console.log(JSON.stringify({",
      "openai: process.env.OPENAI_API_KEY ?? null,",
      "database: process.env.DATABASE_URL ?? null,",
      "home: process.env.HOME,",
      "codexHome: process.env.CODEX_HOME,",
      "wardenExec: process.env.WARDEN_EXEC,",
      "config: fs.readFileSync(configPath, 'utf8')",
      "}));",
    ].join("");

    const code = await runCli(
      ["exec", "--config", "warden.yaml", "--", process.execPath, "-e", script],
      { cwd: dir, ...output.io },
    );
    const result = JSON.parse(output.stdout()) as {
      openai: string | null;
      database: string | null;
      home: string;
      codexHome: string;
      wardenExec: string;
      config: string;
    };

    assert.equal(code, 0);
    assert.equal(result.openai, null);
    assert.equal(result.database, null);
    assert.match(result.home, /warden-exec-/);
    assert.match(result.codexHome, /warden-exec-/);
    assert.equal(result.wardenExec, "1");
    assert.match(result.config, /\[mcp_servers\.warden\]/);
    assert.match(result.config, /"proxy"/);
    assert.match(result.config, /warden\.yaml/);
    assert.match(output.stderr(), /scrubbed HOME=/);
  } finally {
    restoreEnv("OPENAI_API_KEY", previousOpenAiKey);
    restoreEnv("DATABASE_URL", previousDatabaseUrl);
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeFakeUpstreamConfig(dir: string): void {
  const fakeUpstreamPath = join(
    process.cwd(),
    "dist/tests/fixtures/fake-mcp-upstream.js",
  );

  writeFileSync(
    join(dir, "warden.yaml"),
    `defaults:
  read: allow
  write: require_approval
  destructive: require_approval
  external_send: require_approval
  code_execution: require_approval
  file_mutation: require_approval
  network_egress: require_approval
  credential_access: deny
  financial: deny
  sensitive_data: require_approval
  unknown: require_approval

upstreams:
  fixture:
    transport: stdio
    command: ${JSON.stringify(process.execPath)}
    args:
      - ${JSON.stringify(fakeUpstreamPath)}
    startup_timeout_ms: 1000
    tool_timeout_ms: 1000
`,
  );
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

test("CLI init applies approval method and timeout overrides", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const output = createOutput();

  try {
    const code = await runCli(
      ["init", "--approval-method", "local", "--approval-timeout", "30s"],
      { cwd: dir, ...output.io },
    );
    const policy = readFileSync(join(dir, "warden.yaml"), "utf8");

    assert.equal(code, 0);
    assert.match(policy, /method: local/);
    assert.match(policy, /timeout: 30s/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI approvals lists pending approvals and approve resolves them", async () => {
  const queue = new ApprovalQueue();
  const server = createApprovalServer({ queue });
  const port = await listenOnPort(server);
  const url = `http://127.0.0.1:${port}`;

  const ref = makeToolRef("db", "run_sql");
  const request = createApprovalRequest({
    call: {
      ref,
      arguments: { sql: "update users set x = 1" },
      metadata: { ref, description: "", inputSchema: {}, annotations: {} },
    },
    decision: {
      decision: "require_approval",
      reason: "needs review",
      rule: "defaults.write",
      riskLabels: ["write"],
      approval: { timeoutSeconds: 60 },
    },
    redactionFields: [],
  });
  const resolution = resolveApproval(request, queue);
  await new Promise((resolve) => setImmediate(resolve));

  try {
    const listOutput = createOutput();
    const listCode = await runCli(["approvals", "--url", url], {
      cwd: process.cwd(),
      ...listOutput.io,
    });
    assert.equal(listCode, 0);
    assert.match(listOutput.stdout(), /db\.run_sql/);

    const approveOutput = createOutput();
    const approveCode = await runCli(
      ["approve", request.id, "--url", url, "--approver", "alice"],
      { cwd: process.cwd(), ...approveOutput.io },
    );
    assert.equal(approveCode, 0);
    assert.match(approveOutput.stdout(), /Approved/);

    const result = await resolution;
    assert.equal(result.status, "approved");
    assert.equal(result.approver, "alice");
  } finally {
    server.close();
  }
});

test("CLI login pairs a Telegram device and saves credentials with 0600 perms", async () => {
  const fake = await startFakeTelegram({ botUsername: "warden_test_bot" });
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const credPath = join(dir, "telegram.json");
  const output = createOutput();

  try {
    const loginPromise = runCli(
      ["login", "--token", "T", "--api-base-url", fake.url, "--credentials", credPath, "--timeout", "10"],
      { cwd: dir, ...output.io },
    );

    const code = await waitForMatch(output, /start=([0-9a-f]+)/);
    fake.enqueueUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        text: `/start ${code}`,
        chat: { id: 999, type: "private" },
        from: { id: 5 },
      },
    });

    const exit = await loginPromise;
    assert.equal(exit, 0);

    const creds = JSON.parse(readFileSync(credPath, "utf8")) as {
      token: string;
      chatId: number;
    };
    assert.equal(creds.token, "T");
    assert.equal(creds.chatId, 999);
    assert.equal(statSync(credPath).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await fake.close();
  }
});

async function waitForMatch(
  output: { stdout: () => string },
  pattern: RegExp,
): Promise<string> {
  for (let i = 0; i < 400; i += 1) {
    const match = output.stdout().match(pattern);
    if (match?.[1]) {
      return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("pairing link was not printed");
}

function listenOnPort(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

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
