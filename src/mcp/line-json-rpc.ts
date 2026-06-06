import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { JsonValue } from "../domain/types.js";
import {
  errorResponse,
  isRequest,
  isResponse,
  JSON_RPC_ERROR,
  JsonRpcProtocolError,
  parseJsonRpcLine,
  successResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./json-rpc.js";

export type JsonRpcRequestHandler = (
  request: JsonRpcRequest,
) => Promise<JsonValue | undefined>;

export interface LineJsonRpcPeerOptions {
  input: Readable;
  output: Writable;
  requestTimeoutMs?: number;
  onRequest?: JsonRpcRequestHandler;
  onNotification?: (notification: JsonRpcRequest) => void | Promise<void>;
  onError?: (error: Error) => void;
}

interface PendingRequest {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class LineJsonRpcPeer {
  private readonly output: Writable;
  private readonly requestTimeoutMs: number;
  private readonly onRequest: JsonRpcRequestHandler | undefined;
  private readonly onNotification:
    | ((notification: JsonRpcRequest) => void | Promise<void>)
    | undefined;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly rl: Interface;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private nextId = 1;

  constructor(options: LineJsonRpcPeerOptions) {
    this.output = options.output;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.onRequest = options.onRequest;
    this.onNotification = options.onNotification;
    this.onError = options.onError;
    this.rl = createInterface({ input: options.input });
    this.rl.on("line", (line) => {
      void this.handleLine(line);
    });
    this.rl.on("close", () => {
      this.rejectAllPending(new Error("JSON-RPC input closed."));
    });
  }

  async request(method: string, params?: JsonValue): Promise<JsonValue> {
    const id = this.nextId;
    this.nextId += 1;
    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
    };

    if (params !== undefined) {
      message.params = params;
    }

    const promise = new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
    });

    this.write(message);
    return promise;
  }

  notify(method: string, params?: JsonValue): void {
    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
    };

    if (params !== undefined) {
      message.params = params;
    }

    this.write(message);
  }

  close(): void {
    this.rl.close();
    this.rejectAllPending(new Error("JSON-RPC peer closed."));
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) {
      return;
    }

    let message: JsonRpcMessage;
    try {
      message = parseJsonRpcLine(line);
    } catch (error) {
      if (error instanceof JsonRpcProtocolError) {
        this.write(errorResponse(error.id, error.code, error.message, error.data));
      }
      this.emitError(error);
      return;
    }

    if (isResponse(message)) {
      this.handleResponse(message);
      return;
    }

    if (!isRequest(message)) {
      return;
    }

    if (message.id === undefined) {
      await this.handleNotification(message);
      return;
    }

    await this.handleRequest(message);
  }

  private handleResponse(message: JsonRpcResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.emitError(new Error(`Received response for unknown id: ${String(message.id)}`));
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if ("error" in message) {
      pending.reject(
        new JsonRpcProtocolError(
          message.error.code,
          message.error.message,
          message.id,
          message.error.data,
        ),
      );
      return;
    }

    pending.resolve(message.result);
  }

  private async handleRequest(message: JsonRpcRequest): Promise<void> {
    if (!this.onRequest) {
      this.write(
        errorResponse(
          message.id ?? null,
          JSON_RPC_ERROR.methodNotFound,
          `Method not found: ${message.method}`,
        ),
      );
      return;
    }

    try {
      const result = await this.onRequest(message);
      this.write(successResponse(message.id ?? null, result ?? null));
    } catch (error) {
      if (error instanceof JsonRpcProtocolError) {
        this.write(errorResponse(message.id ?? null, error.code, error.message, error.data));
      } else {
        this.write(
          errorResponse(
            message.id ?? null,
            JSON_RPC_ERROR.internalError,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
  }

  private async handleNotification(message: JsonRpcRequest): Promise<void> {
    try {
      await this.onNotification?.(message);
    } catch (error) {
      this.emitError(error);
    }
  }

  private write(message: JsonRpcMessage): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private emitError(error: unknown): void {
    this.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}
