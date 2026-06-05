import { makeToolRef, parseToolRef } from "../domain/tool-ref.js";
import type { JsonObject, JsonValue, PolicyConfig, ToolCall, ToolMetadata } from "../domain/types.js";
import { handleToolCall, type ToolExecutor } from "../pipeline/handle-tool-call.js";
import { JSON_RPC_ERROR, JsonRpcProtocolError, type JsonRpcRequest } from "./json-rpc.js";
import type { McpTool, McpToolCallParams, McpToolCallResult, McpInitializeResult } from "./types.js";
import type { McpUpstream } from "./upstream.js";
import type { ApprovalReviewer } from "../approval/approval.js";

interface ToolInventoryEntry {
  upstream: McpUpstream;
  upstreamTool: McpTool;
  metadata: ToolMetadata;
}

export interface McpGatewayOptions {
  config: PolicyConfig;
  upstreams: McpUpstream[];
  reviewer?: ApprovalReviewer;
  auditPath?: string;
}

export class McpGateway {
  private readonly config: PolicyConfig;
  private readonly upstreams = new Map<string, McpUpstream>();
  private readonly reviewer: ApprovalReviewer | undefined;
  private readonly auditPath: string | undefined;
  private readonly inventory = new Map<string, ToolInventoryEntry>();

  constructor(options: McpGatewayOptions) {
    this.config = options.config;
    this.reviewer = options.reviewer;
    this.auditPath = options.auditPath;

    for (const upstream of options.upstreams) {
      if (this.upstreams.has(upstream.name)) {
        throw new Error(`Duplicate upstream name: ${upstream.name}`);
      }
      this.upstreams.set(upstream.name, upstream);
    }
  }

  async initialize(): Promise<void> {
    await Promise.all([...this.upstreams.values()].map((upstream) => upstream.initialize()));
  }

  close(): void {
    for (const upstream of this.upstreams.values()) {
      upstream.close();
    }
  }

  async handleRequest(request: JsonRpcRequest): Promise<JsonValue> {
    switch (request.method) {
      case "initialize":
        return this.handleInitialize(request.params);
      case "ping":
        return {};
      case "tools/list":
        return this.handleToolsList();
      case "tools/call":
        return this.handleToolsCall(request.params);
      default:
        throw new JsonRpcProtocolError(
          JSON_RPC_ERROR.methodNotFound,
          `Method not found: ${request.method}`,
          request.id ?? null,
        );
    }
  }

  private handleInitialize(params: JsonValue | undefined): McpInitializeResult {
    const requestedProtocol =
      isJsonObject(params) && typeof params["protocolVersion"] === "string"
        ? params["protocolVersion"]
        : "2025-06-18";

    return {
      protocolVersion: requestedProtocol,
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "warden",
        version: "0.1.0",
      },
    };
  }

  private async handleToolsList(): Promise<{ tools: McpTool[] }> {
    this.inventory.clear();
    const tools: McpTool[] = [];

    for (const upstream of this.upstreams.values()) {
      const upstreamTools = await upstream.listTools();
      for (const upstreamTool of upstreamTools) {
        const ref = makeToolRef(upstream.name, upstreamTool.name);
        const metadata: ToolMetadata = {
          ref,
          description: upstreamTool.description ?? "",
          inputSchema: upstreamTool.inputSchema,
          annotations: upstreamTool.annotations ?? {},
        };
        const namespacedTool: McpTool = {
          name: ref.fullName,
          inputSchema: upstreamTool.inputSchema,
        };
        if (upstreamTool.description !== undefined) {
          namespacedTool.description = upstreamTool.description;
        }
        if (upstreamTool.annotations !== undefined) {
          namespacedTool.annotations = upstreamTool.annotations;
        }

        this.inventory.set(ref.fullName, {
          upstream,
          upstreamTool,
          metadata,
        });
        tools.push(stripUndefinedToolFields(namespacedTool));
      }
    }

    return { tools };
  }

  private async handleToolsCall(params: JsonValue | undefined): Promise<McpToolCallResult> {
    const callParams = normalizeToolCallParams(params);
    let entry = this.inventory.get(callParams.name);

    if (!entry) {
      await this.handleToolsList();
      entry = this.inventory.get(callParams.name);
    }

    if (!entry) {
      throw new JsonRpcProtocolError(
        JSON_RPC_ERROR.invalidParams,
        `Unknown Warden tool: ${callParams.name}`,
        null,
      );
    }

    const ref = parseToolRef(callParams.name);
    const toolCall: ToolCall = {
      ref,
      metadata: entry.metadata,
      arguments: callParams.arguments ?? {},
      client: "mcp",
      agent: "unknown_agent",
      user: "unknown_user",
    };
    const executor: ToolExecutor = {
      execute: async (call) => {
        const result = await entry.upstream.callTool(entry.upstreamTool.name, call.arguments);
        if (result.isError) {
          return {
            status: "error",
            output: result,
            summary: "Upstream tool returned isError=true.",
            error: extractTextContent(result),
          };
        }

        return {
          status: "success",
          output: result,
          summary: extractTextContent(result),
        };
      },
    };
    const pipelineInput = {
      config: this.config,
      call: toolCall,
      executor,
    };
    if (this.auditPath) {
      Object.assign(pipelineInput, { auditPath: this.auditPath });
    }
    if (this.reviewer) {
      Object.assign(pipelineInput, { reviewer: this.reviewer });
    }
    const pipelineResult = await handleToolCall(pipelineInput);

    if (!pipelineResult.executed) {
      return policyBlockedToolResult(pipelineResult.auditEvent.id, pipelineResult.error);
    }

    if (isJsonObject(pipelineResult.output)) {
      return normalizeGatewayToolResult(pipelineResult.output);
    }

    return {
      content: [
        {
          type: "text",
          text: pipelineResult.output === undefined ? "" : JSON.stringify(pipelineResult.output),
        },
      ],
    };
  }
}

function normalizeToolCallParams(params: JsonValue | undefined): McpToolCallParams {
  if (!isJsonObject(params) || typeof params["name"] !== "string") {
    throw new JsonRpcProtocolError(
      JSON_RPC_ERROR.invalidParams,
      "tools/call params must include a string name.",
      null,
    );
  }

  const args = params["arguments"];
  if (args !== undefined && !isJsonObject(args)) {
    throw new JsonRpcProtocolError(
      JSON_RPC_ERROR.invalidParams,
      "tools/call arguments must be an object when provided.",
      null,
    );
  }

  const normalized: McpToolCallParams = {
    name: params["name"],
  };
  if (args !== undefined) {
    normalized.arguments = args;
  }

  return normalized;
}

function normalizeGatewayToolResult(value: JsonObject): McpToolCallResult {
  if (!Array.isArray(value["content"])) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(value),
        },
      ],
    };
  }

  const result: McpToolCallResult = {
    content: value["content"],
  };

  if (typeof value["isError"] === "boolean") {
    result.isError = value["isError"];
  }

  return result;
}

function policyBlockedToolResult(decisionId: string, error: string | undefined): McpToolCallResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: "tool_call_not_executed",
          message: "This action was not executed by Warden policy.",
          decision_id: decisionId,
          reason: error ?? "Blocked by policy.",
        }),
      },
    ],
  };
}

function extractTextContent(result: McpToolCallResult): string {
  return result.content
    .map((item) => {
      if (isJsonObject(item) && typeof item["text"] === "string") {
        return item["text"];
      }
      return JSON.stringify(item);
    })
    .join("\n")
    .slice(0, 1000);
}

function stripUndefinedToolFields(tool: McpTool): McpTool {
  const result: McpTool = {
    name: tool.name,
    inputSchema: tool.inputSchema,
  };

  if (tool.description !== undefined) {
    result.description = tool.description;
  }

  if (tool.annotations !== undefined) {
    result.annotations = tool.annotations;
  }

  return result;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
