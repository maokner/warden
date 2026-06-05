import type { JsonObject, JsonValue } from "../domain/types.js";

export interface McpTool extends JsonObject {
  name: string;
  description?: string;
  inputSchema: JsonObject;
  annotations?: JsonObject;
}

export interface McpToolsListResult extends JsonObject {
  tools: McpTool[];
}

export interface McpToolCallParams {
  name: string;
  arguments?: JsonObject;
}

export interface McpToolCallResult extends JsonObject {
  content: JsonValue[];
  isError?: boolean;
}

export interface McpInitializeResult extends JsonObject {
  protocolVersion: string;
  capabilities: JsonObject;
  serverInfo: {
    name: string;
    version: string;
  };
}
