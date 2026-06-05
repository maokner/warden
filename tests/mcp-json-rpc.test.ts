import { PassThrough } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";
import {
  JSON_RPC_ERROR,
  JsonRpcProtocolError,
  parseJsonRpcLine,
} from "../src/mcp/json-rpc.js";
import { LineJsonRpcPeer } from "../src/mcp/line-json-rpc.js";

test("parseJsonRpcLine parses requests and notifications", () => {
  assert.deepEqual(
    parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"method":"tools/list"}'),
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    },
  );

  assert.deepEqual(
    parseJsonRpcLine('{"jsonrpc":"2.0","method":"notifications/initialized"}'),
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    },
  );
});

test("parseJsonRpcLine rejects malformed messages with protocol errors", () => {
  assert.throws(
    () => parseJsonRpcLine("{nope"),
    (error) =>
      error instanceof JsonRpcProtocolError &&
      error.code === JSON_RPC_ERROR.parseError,
  );

  assert.throws(
    () => parseJsonRpcLine('{"jsonrpc":"2.0","id":{},"method":"x"}'),
    (error) =>
      error instanceof JsonRpcProtocolError &&
      error.code === JSON_RPC_ERROR.invalidRequest,
  );
});

test("LineJsonRpcPeer supports request response round trips", async () => {
  const pair = createPeerPair({
    onRequest: async (request) => {
      assert.equal(request.method, "ping");
      return { pong: true };
    },
  });

  try {
    const result = await pair.client.request("ping", { value: 1 });
    assert.deepEqual(result, { pong: true });
  } finally {
    pair.close();
  }
});

test("LineJsonRpcPeer delivers notifications without responses", async () => {
  let notificationMethod = "";
  const pair = createPeerPair({
    onNotification: (notification) => {
      notificationMethod = notification.method;
    },
  });

  try {
    pair.client.notify("notifications/initialized");
    await wait(5);
    assert.equal(notificationMethod, "notifications/initialized");
  } finally {
    pair.close();
  }
});

test("LineJsonRpcPeer returns method-not-found when no handler exists", async () => {
  const pair = createPeerPair({});

  try {
    await assert.rejects(
      () => pair.client.request("missing"),
      (error) =>
        error instanceof JsonRpcProtocolError &&
        error.code === JSON_RPC_ERROR.methodNotFound,
    );
  } finally {
    pair.close();
  }
});

test("LineJsonRpcPeer times out unanswered requests", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new LineJsonRpcPeer({
    input,
    output,
    requestTimeoutMs: 5,
  });

  try {
    await assert.rejects(() => peer.request("never"), /timed out/);
  } finally {
    peer.close();
  }
});

function createPeerPair(serverHandlers: {
  onRequest?: ConstructorParameters<typeof LineJsonRpcPeer>[0]["onRequest"];
  onNotification?: ConstructorParameters<typeof LineJsonRpcPeer>[0]["onNotification"];
}): {
  client: LineJsonRpcPeer;
  server: LineJsonRpcPeer;
  close: () => void;
} {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const client = new LineJsonRpcPeer({
    input: serverToClient,
    output: clientToServer,
    requestTimeoutMs: 100,
  });
  const serverOptions = {
    input: clientToServer,
    output: serverToClient,
    requestTimeoutMs: 100,
  };
  if (serverHandlers.onRequest) {
    Object.assign(serverOptions, { onRequest: serverHandlers.onRequest });
  }
  if (serverHandlers.onNotification) {
    Object.assign(serverOptions, {
      onNotification: serverHandlers.onNotification,
    });
  }
  const server = new LineJsonRpcPeer(serverOptions);

  return {
    client,
    server,
    close: () => {
      client.close();
      server.close();
    },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
