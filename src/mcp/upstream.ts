import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import type { JsonObject, JsonValue, UpstreamConfig } from "../domain/types.js";
import { scrubEnvironment } from "../env/protection.js";
import { JSON_RPC_ERROR, JsonRpcProtocolError } from "./json-rpc.js";
import { LineJsonRpcPeer } from "./line-json-rpc.js";
import type { McpTool, McpToolCallResult, McpToolsListResult } from "./types.js";

export interface McpUpstream {
  readonly name: string;
  initialize: () => Promise<void>;
  listTools: () => Promise<McpTool[]>;
  callTool: (toolName: string, args: JsonObject) => Promise<McpToolCallResult>;
  close: () => void;
}

export class StdioMcpUpstreamClient implements McpUpstream {
  readonly name: string;
  private readonly config: UpstreamConfig;
  private child: ChildProcessWithoutNullStreams | undefined;
  private peer: LineJsonRpcPeer | undefined;

  constructor(name: string, config: UpstreamConfig) {
    this.name = name;
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.peer) {
      return;
    }

    const child = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd ? resolve(this.config.cwd) : undefined,
      env: { ...scrubEnvironment(process.env), ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stderr.on("data", (chunk) => {
      process.stderr.write(`[warden upstream ${this.name}] ${String(chunk)}`);
    });

    this.child = child;
    this.peer = new LineJsonRpcPeer({
      input: child.stdout,
      output: child.stdin,
      requestTimeoutMs: this.config.toolTimeoutMs,
    });

    child.once("exit", (code, signal) => {
      this.peer?.close();
      this.peer = undefined;
      if (code !== 0 && signal === null) {
        process.stderr.write(
          `[warden upstream ${this.name}] exited with code ${String(code)}\n`,
        );
      }
    });

    await this.requestWithStartupTimeout("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "warden",
        version: "0.1.0",
      },
    });
    this.peer.notify("notifications/initialized");
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.request("tools/list", {});
    const parsed = normalizeToolsListResult(result, this.name);
    return parsed.tools;
  }

  async callTool(toolName: string, args: JsonObject): Promise<McpToolCallResult> {
    const result = await this.request("tools/call", {
      name: toolName,
      arguments: args,
    });

    return normalizeToolCallResult(result, this.name, toolName);
  }

  close(): void {
    this.peer?.close();
    this.peer = undefined;
    this.child?.kill();
    this.child = undefined;
  }

  private async request(method: string, params: JsonObject): Promise<JsonValue> {
    if (!this.peer) {
      await this.initialize();
    }

    if (!this.peer) {
      throw new Error(`Upstream ${this.name} did not initialize.`);
    }

    return this.peer.request(method, params);
  }

  private async requestWithStartupTimeout(
    method: string,
    params: JsonObject,
  ): Promise<JsonValue> {
    if (!this.peer) {
      throw new Error(`Upstream ${this.name} did not start.`);
    }

    let timer: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        this.peer.request(method, params),
        new Promise<JsonValue>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Upstream ${this.name} startup timed out.`)),
            this.config.startupTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

export function createStdioUpstreams(
  upstreamConfigs: Record<string, UpstreamConfig>,
): McpUpstream[] {
  return Object.entries(upstreamConfigs).map(
    ([name, config]) => new StdioMcpUpstreamClient(name, config),
  );
}

function normalizeToolsListResult(value: JsonValue, upstream: string): McpToolsListResult {
  if (!isJsonObject(value) || !Array.isArray(value["tools"])) {
    throw new JsonRpcProtocolError(
      JSON_RPC_ERROR.internalError,
      `Upstream ${upstream} returned malformed tools/list result.`,
      null,
    );
  }

  return {
    tools: value["tools"].map((tool, index) => normalizeTool(tool, upstream, index)),
  };
}

function normalizeTool(value: JsonValue, upstream: string, index: number): McpTool {
  if (!isJsonObject(value) || typeof value["name"] !== "string") {
    throw new JsonRpcProtocolError(
      JSON_RPC_ERROR.internalError,
      `Upstream ${upstream} returned malformed tool at index ${index}.`,
      null,
    );
  }

  const tool: McpTool = {
    name: value["name"],
    inputSchema: isJsonObject(value["inputSchema"]) ? value["inputSchema"] : {},
  };

  if (typeof value["description"] === "string") {
    tool.description = value["description"];
  }

  if (isJsonObject(value["annotations"])) {
    tool.annotations = value["annotations"];
  }

  return tool;
}

function normalizeToolCallResult(
  value: JsonValue,
  upstream: string,
  toolName: string,
): McpToolCallResult {
  if (!isJsonObject(value) || !Array.isArray(value["content"])) {
    throw new JsonRpcProtocolError(
      JSON_RPC_ERROR.internalError,
      `Upstream ${upstream}.${toolName} returned malformed tools/call result.`,
      null,
    );
  }

  const result: McpToolCallResult = {
    content: value["content"],
  };

  if (typeof value["isError"] === "boolean") {
    result.isError = value["isError"];
  }

  return result;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
