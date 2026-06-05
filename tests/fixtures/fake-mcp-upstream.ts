import { LineJsonRpcPeer } from "../../src/mcp/line-json-rpc.js";
import { JSON_RPC_ERROR, JsonRpcProtocolError, type JsonRpcRequest } from "../../src/mcp/json-rpc.js";

const tools = [
  {
    name: "read_echo",
    description: "Read an echo value",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string" },
      },
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  {
    name: "write_echo",
    description: "Write an echo value",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string" },
      },
    },
  },
];

new LineJsonRpcPeer({
  input: process.stdin,
  output: process.stdout,
  onRequest: async (request) => handleRequest(request),
});

async function handleRequest(request: JsonRpcRequest) {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "fake-upstream",
          version: "0.0.0",
        },
      };
    case "tools/list":
      return { tools };
    case "tools/call":
      return handleToolCall(request);
    default:
      throw new JsonRpcProtocolError(
        JSON_RPC_ERROR.methodNotFound,
        `Method not found: ${request.method}`,
        request.id ?? null,
      );
  }
}

function handleToolCall(request: JsonRpcRequest) {
  const params = request.params;
  if (
    typeof params !== "object" ||
    params === null ||
    Array.isArray(params) ||
    typeof params["name"] !== "string"
  ) {
    throw new JsonRpcProtocolError(
      JSON_RPC_ERROR.invalidParams,
      "tools/call params must include name.",
      request.id ?? null,
    );
  }

  return {
    content: [
      {
        type: "text",
        text: `called:${params["name"]}`,
      },
    ],
  };
}
