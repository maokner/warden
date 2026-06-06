import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import type { ApprovalReviewer } from "../src/approval/approval.js";
import type { JsonObject } from "../src/domain/types.js";
import { JSON_RPC_ERROR, JsonRpcProtocolError, type JsonRpcRequest } from "../src/mcp/json-rpc.js";
import { McpGateway } from "../src/mcp/gateway.js";
import type { McpTool, McpToolCallResult } from "../src/mcp/types.js";
import { StdioMcpUpstreamClient, type McpUpstream } from "../src/mcp/upstream.js";
import { defaultPolicyConfig } from "../src/policy/defaults.js";
import { readAuditEvents } from "../src/audit/logger.js";

test("McpGateway initialize returns a Warden MCP server shape", async () => {
  const gateway = new McpGateway({
    config: defaultPolicyConfig(),
    upstreams: [],
  });

  const result = await gateway.handleRequest(request("initialize", {
    protocolVersion: "2025-06-18",
  }));

  assert.deepEqual(result, {
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "warden", version: "0.1.0" },
  });
});

test("McpGateway lists namespaced upstream tools", async () => {
  const upstream = fakeUpstream("filesystem");
  const gateway = new McpGateway({
    config: defaultPolicyConfig(),
    upstreams: [upstream],
  });

  const result = await gateway.handleRequest(request("tools/list"));

  assert.deepEqual(
    (result as { tools: McpTool[] }).tools.map((tool) => tool.name),
    [
      "filesystem.read_file",
      "filesystem.write_file",
      "filesystem.delete_file",
      "filesystem.refund_payment",
    ],
  );
});

test("McpGateway executes allowed read calls and writes audit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-gateway-"));
  const auditPath = join(dir, "audit.jsonl");
  const upstream = fakeUpstream("filesystem");
  const gateway = new McpGateway({
    config: defaultPolicyConfig(),
    upstreams: [upstream],
    auditPath,
  });

  try {
    const result = (await gateway.handleRequest(
      request("tools/call", {
        name: "filesystem.read_file",
        arguments: { path: "README.md" },
      }),
    )) as McpToolCallResult;

    assert.equal(result.isError, undefined);
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0]?.toolName, "read_file");
    assert.equal(readText(result), "upstream:read_file");
    const events = readAuditEvents(auditPath);
    assert.equal(events[0]?.decision, "allow");
    assert.equal(events[0]?.responseStatus, "success");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("McpGateway blocks approval-required calls when no reviewer is configured", async () => {
  const upstream = fakeUpstream("filesystem");
  const gateway = new McpGateway({
    config: defaultPolicyConfig(),
    upstreams: [upstream],
  });

  const result = (await gateway.handleRequest(
    request("tools/call", {
      name: "filesystem.write_file",
      arguments: { path: "src/config.ts", content: "hello" },
    }),
  )) as McpToolCallResult;

  assert.equal(result.isError, true);
  assert.equal(upstream.calls.length, 0);
  assert.match(readText(result), /tool_call_not_executed/);
});

test("McpGateway executes approved write calls", async () => {
  const upstream = fakeUpstream("filesystem");
  const reviewer: ApprovalReviewer = {
    review: async () => ({ action: "approve", approver: "human" }),
  };
  const gateway = new McpGateway({
    config: defaultPolicyConfig(),
    upstreams: [upstream],
    reviewer,
  });

  const result = (await gateway.handleRequest(
    request("tools/call", {
      name: "filesystem.write_file",
      arguments: { path: "src/config.ts", content: "hello" },
    }),
  )) as McpToolCallResult;

  assert.equal(result.isError, undefined);
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0]?.toolName, "write_file");
});

test("McpGateway denies financial calls before upstream execution", async () => {
  const upstream = fakeUpstream("payments");
  const gateway = new McpGateway({
    config: defaultPolicyConfig(),
    upstreams: [upstream],
  });

  const result = (await gateway.handleRequest(
    request("tools/call", {
      name: "payments.refund_payment",
      arguments: { payment_intent: "pi_123" },
    }),
  )) as McpToolCallResult;

  assert.equal(result.isError, true);
  assert.equal(upstream.calls.length, 0);
});

test("McpGateway rejects unknown tools with invalid params", async () => {
  const gateway = new McpGateway({
    config: defaultPolicyConfig(),
    upstreams: [fakeUpstream("filesystem")],
  });

  await assert.rejects(
    () =>
      gateway.handleRequest(
        request("tools/call", {
          name: "filesystem.missing",
          arguments: {},
        }),
      ),
    (error) =>
      error instanceof JsonRpcProtocolError &&
      error.code === JSON_RPC_ERROR.invalidParams,
  );
});

test("McpGateway preserves upstream tool errors instead of converting them to policy blocks", async () => {
  const upstream = fakeUpstream("filesystem");
  upstream.failNextCall = true;
  const gateway = new McpGateway({
    config: defaultPolicyConfig(),
    upstreams: [upstream],
  });

  const result = (await gateway.handleRequest(
    request("tools/call", {
      name: "filesystem.read_file",
      arguments: { path: "README.md" },
    }),
  )) as McpToolCallResult;

  assert.equal(result.isError, true);
  assert.equal(readText(result), "upstream failed");
  assert.equal(upstream.calls.length, 1);
});

test("McpGateway does not write audit logs unless auditPath is explicitly supplied", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-gateway-"));
  const auditPath = join(dir, "audit.jsonl");
  const config = defaultPolicyConfig();
  config.auditPath = auditPath;
  const gateway = new McpGateway({
    config,
    upstreams: [fakeUpstream("filesystem")],
  });

  try {
    await gateway.handleRequest(
      request("tools/call", {
        name: "filesystem.read_file",
        arguments: { path: "README.md" },
      }),
    );

    assert.equal(existsSync(auditPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("StdioMcpUpstreamClient talks to a real child process upstream", async () => {
  const upstream = new StdioMcpUpstreamClient("fixture", {
    transport: "stdio",
    command: process.execPath,
    args: [join(process.cwd(), "dist/tests/fixtures/fake-mcp-upstream.js")],
    env: {},
    startupTimeoutMs: 1_000,
    toolTimeoutMs: 1_000,
  });

  try {
    await upstream.initialize();
    const tools = await upstream.listTools();
    const result = await upstream.callTool("read_echo", { value: "hello" });

    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["read_echo", "write_echo"],
    );
    assert.equal(readText(result), "called:read_echo");
  } finally {
    upstream.close();
  }
});

test("StdioMcpUpstreamClient scrubs protected parent env before spawning upstreams", async () => {
  const previousOpenAiKey = process.env["OPENAI_API_KEY"];
  process.env["OPENAI_API_KEY"] = "sk-parent";
  const script = [
    "const readline = require('node:readline');",
    "const rl = readline.createInterface({ input: process.stdin });",
    "const tools = [{ name: 'read_env', description: 'Read env', inputSchema: {}, annotations: { readOnlyHint: true } }];",
    "function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }",
    "rl.on('line', (line) => {",
    "  const msg = JSON.parse(line);",
    "  if (msg.method === 'initialize') send(msg.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'env-fixture', version: '0' } });",
    "  if (msg.method === 'tools/list') send(msg.id, { tools });",
    "  if (msg.method === 'tools/call') send(msg.id, { content: [{ type: 'text', text: JSON.stringify({ openai: process.env.OPENAI_API_KEY ?? null, explicit: process.env.EXPLICIT_TOKEN ?? null }) }] });",
    "});",
  ].join("");
  const upstream = new StdioMcpUpstreamClient("fixture", {
    transport: "stdio",
    command: process.execPath,
    args: ["-e", script],
    env: { EXPLICIT_TOKEN: "allowed" },
    startupTimeoutMs: 1_000,
    toolTimeoutMs: 1_000,
  });

  try {
    await upstream.initialize();
    const result = await upstream.callTool("read_env", {});
    const env = JSON.parse(readText(result)) as {
      openai: string | null;
      explicit: string | null;
    };

    assert.equal(env.openai, null);
    assert.equal(env.explicit, "allowed");
  } finally {
    restoreEnv("OPENAI_API_KEY", previousOpenAiKey);
    upstream.close();
  }
});

function fakeUpstream(name: string): McpUpstream & {
  calls: Array<{ toolName: string; args: JsonObject }>;
  failNextCall: boolean;
} {
  const calls: Array<{ toolName: string; args: JsonObject }> = [];
  const tools: McpTool[] = [
    {
      name: "read_file",
      description: "Read a file from disk",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    {
      name: "write_file",
      description: "Write a file to disk",
      inputSchema: {},
    },
    {
      name: "delete_file",
      description: "Delete a file from disk",
      inputSchema: {},
    },
    {
      name: "refund_payment",
      description: "Refund a payment",
      inputSchema: {},
    },
  ];

  const upstream = {
    name,
    calls,
    failNextCall: false,
    initialize: async () => undefined,
    listTools: async () => tools,
    callTool: async (toolName: string, args: JsonObject) => {
      calls.push({ toolName, args });
      if (upstream.failNextCall) {
        upstream.failNextCall = false;
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "upstream failed",
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `upstream:${toolName}`,
          },
        ],
      };
    },
    close: () => undefined,
  };

  return upstream;
}

function request(method: string, params?: JsonObject): JsonRpcRequest {
  const message: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 1,
    method,
  };

  if (params !== undefined) {
    message.params = params;
  }

  return message;
}

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

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
