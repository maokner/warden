import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/cli/app.js";
import { readAuditEvents } from "../src/audit/logger.js";
import { LineJsonRpcPeer } from "../src/mcp/line-json-rpc.js";
import type { McpTool, McpToolCallResult } from "../src/mcp/types.js";

test("warden proxy serves MCP over stdio end to end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-proxy-"));
  const configPath = join(dir, "warden.yaml");
  const fakeUpstreamPath = join(
    process.cwd(),
    "dist/tests/fixtures/fake-mcp-upstream.js",
  );
  writeFileSync(
    configPath,
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

audit:
  path: ${join(dir, "audit.jsonl")}

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

  const child = spawn(process.execPath, [
    join(process.cwd(), "dist/src/cli/index.js"),
    "proxy",
    "--config",
    configPath,
  ], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
  });
  const peer = new LineJsonRpcPeer({
    input: child.stdout,
    output: child.stdin,
    requestTimeoutMs: 2_000,
  });

  try {
    const init = await peer.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    });
    peer.notify("notifications/initialized");
    const list = (await peer.request("tools/list", {})) as { tools: McpTool[] };
    const readResult = (await peer.request("tools/call", {
      name: "fixture.read_echo",
      arguments: { value: "hello" },
    })) as McpToolCallResult;
    const writeResult = (await peer.request("tools/call", {
      name: "fixture.write_echo",
      arguments: { value: "hello" },
    })) as McpToolCallResult;

    assert.deepEqual(init, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "warden", version: "0.1.0" },
    });
    assert.deepEqual(
      list.tools.map((tool) => tool.name),
      ["fixture.read_echo", "fixture.write_echo"],
    );
    assert.equal(readText(readResult), "called:read_echo");
    assert.equal(writeResult.isError, true);
    assert.match(readText(writeResult), /tool_call_not_executed/);
    assert.match(stderr.join(""), /Warden proxy started with 1 upstream/);
  } finally {
    peer.close();
    child.stdin.end();
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("warden proxy executes approval-required calls through a side-channel reviewer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-proxy-"));
  const configPath = join(dir, "warden.yaml");
  const auditPath = join(dir, "audit.jsonl");
  const fakeUpstreamPath = join(
    process.cwd(),
    "dist/tests/fixtures/fake-mcp-upstream.js",
  );
  writeFileSync(
    configPath,
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

audit:
  path: ${auditPath}

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

  const clientToProxy = new PassThrough();
  const proxyToClient = new PassThrough();
  const approvalInput = new PassThrough();
  const approvalOutput = new PassThrough();
  const approvalChunks: string[] = [];
  approvalOutput.on("data", (chunk) => {
    approvalChunks.push(String(chunk));
  });
  const cliOutput = createOutput();
  const run = runCli(["proxy", "--config", configPath, "--approver", "test-human"], {
    cwd: dir,
    ...cliOutput.io,
    mcpInput: clientToProxy,
    mcpOutput: proxyToClient,
    approvalInput,
    approvalOutput,
  });
  const peer = new LineJsonRpcPeer({
    input: proxyToClient,
    output: clientToProxy,
    requestTimeoutMs: 2_000,
  });

  try {
    await peer.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    });
    peer.notify("notifications/initialized");
    await peer.request("tools/list", {});

    const write = peer.request("tools/call", {
      name: "fixture.write_echo",
      arguments: { value: "hello" },
    }) as Promise<McpToolCallResult>;
    approvalInput.write("a\n");
    const writeResult = await write;

    assert.equal(writeResult.isError, undefined);
    assert.equal(readText(writeResult), "called:write_echo");
    assert.match(approvalChunks.join(""), /Warden approval required/);
    assert.match(cliOutput.stderr(), /Approval side channel: injected terminal streams/);

    const events = readAuditEvents(auditPath);
    assert.equal(events[0]?.decision, "require_approval");
    assert.equal(events[0]?.approvalId?.startsWith("appr_"), true);
    assert.deepEqual(events[0]?.executedArguments, { value: "hello" });
  } finally {
    peer.close();
    clientToProxy.end();
    await run;
    proxyToClient.destroy();
    approvalInput.destroy();
    approvalOutput.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

function readText(result: McpToolCallResult): string {
  const first = result.content[0];
  if (typeof first === "object" && first !== null && !Array.isArray(first)) {
    const text = first["text"];
    if (typeof text === "string") {
      return text;
    }
  }

  return JSON.stringify(result.content);
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
