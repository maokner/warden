import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { readAuditEvents } from "../src/audit/logger.js";
import type { JsonObject } from "../src/domain/types.js";
import {
  createHttpDecisionServer,
  decideHttpAction,
  type HttpDecisionResponse,
} from "../src/http/sidecar.js";
import { defaultPolicyConfig } from "../src/policy/defaults.js";

test("decideHttpAction returns allow decisions with forward arguments", () => {
  const config = defaultPolicyConfig();
  const result = decideHttpAction({
    config,
    request: {
      tool: "database.run_sql",
      description: "Run SQL against the application database",
      arguments: { sql: "select id from feature_flags limit 1" },
      client: "python_app",
      agent: "support_agent",
      user: "user_123",
    },
  });

  assert.equal(result.status, "allowed");
  assert.equal(result.allowed, true);
  assert.equal(result.requiresApproval, false);
  assert.equal(result.decision.decision, "allow");
  assert.deepEqual(result.forwardArguments, {
    sql: "select id from feature_flags limit 1",
  });
  assert.equal(result.auditEvent.client, "python_app");
  assert.equal(result.auditEvent.agent, "support_agent");
  assert.equal(result.auditEvent.user, "user_123");
});

test("decideHttpAction returns approval requirements without forward arguments", () => {
  const config = defaultPolicyConfig();
  const result = decideHttpAction({
    config,
    request: {
      tool: "database.run_sql",
      description: "Run SQL against the application database",
      arguments: { sql: "update users set plan = 'pro' where id = 1" },
    },
  });

  assert.equal(result.status, "requires_approval");
  assert.equal(result.allowed, false);
  assert.equal(result.requiresApproval, true);
  assert.equal(result.decision.decision, "require_approval");
  assert.equal(result.forwardArguments, undefined);
  assert.match(result.error ?? "", /Approval required/);
});

test("decideHttpAction returns redacted forward arguments and writes audit", () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-http-"));
  const auditPath = join(dir, "audit.jsonl");
  const config = defaultPolicyConfig();
  config.tools["api.read_payload"] = { decision: "redact_then_allow" };
  config.redaction.fields.push("payload");

  try {
    const result = decideHttpAction({
      config,
      auditPath,
      request: {
        tool: "api.read_payload",
        description: "Read a payload",
        arguments: {
          content: "password=secret&safe=true",
          payload: "internal value",
          keep: "visible",
        },
      },
    });

    assert.equal(result.status, "allowed");
    assert.equal(result.decision.decision, "redact_then_allow");
    assert.deepEqual(result.forwardArguments, {
      content: "password=[REDACTED]&safe=true",
      payload: "[REDACTED]",
      keep: "visible",
    });

    const events = readAuditEvents(auditPath);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.decision, "redact_then_allow");
    assert.deepEqual(events[0]?.requestArguments, {
      content: "password=[REDACTED]&safe=true",
      payload: "[REDACTED]",
      keep: "visible",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decideHttpAction refuses transform_then_allow without returning original args", () => {
  const config = defaultPolicyConfig();
  config.tools["api.read_payload"] = { decision: "transform_then_allow" };

  const result = decideHttpAction({
    config,
    request: {
      tool: "api.read_payload",
      description: "Read a payload",
      arguments: { limit: 1000 },
    },
  });

  assert.equal(result.status, "unsupported");
  assert.equal(result.allowed, false);
  assert.equal(result.forwardArguments, undefined);
  assert.match(result.error ?? "", /not implemented/);
});

test("HTTP sidecar serves health and decision endpoints", async () => {
  const config = defaultPolicyConfig();
  const server = createHttpDecisionServer({ config });

  await withServer(server, async (baseUrl) => {
    const health = await fetchJson(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { status: "ok" });

    const decision = await postJson(`${baseUrl}/v1/decide`, {
      tool: "database.run_sql",
      description: "Run SQL against the application database",
      arguments: { sql: "select 1" },
    });

    assert.equal(decision.status, 200);
    assert.equal(decision.body.status, "allowed");
    assert.equal(decision.body.allowed, true);
    assert.deepEqual(decision.body.forwardArguments, { sql: "select 1" });
  });
});

test("HTTP sidecar rejects malformed requests", async () => {
  const config = defaultPolicyConfig();
  const server = createHttpDecisionServer({ config, maxBodyBytes: 128 });

  await withServer(server, async (baseUrl) => {
    const missing = await fetchJson(`${baseUrl}/missing`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "not_found");

    const wrongMethod = await fetchJson(`${baseUrl}/v1/decide`);
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.body.error, "method_not_allowed");

    const invalidJson = await fetch(`${baseUrl}/v1/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal(invalidJson.status, 400);

    const arrayArguments = await postJson(`${baseUrl}/v1/decide`, {
      tool: "database.run_sql",
      arguments: ["select 1"],
    });
    assert.equal(arrayArguments.status, 400);
    const message = arrayArguments.body.message;
    if (typeof message !== "string") {
      throw new Error("Expected validation response message to be a string.");
    }
    assert.match(message, /arguments must be an object/);

    const invalidTool = await postJson(`${baseUrl}/v1/decide`, {
      tool: "invalid",
      arguments: {},
    });
    assert.equal(invalidTool.status, 400);
    assert.match(String(invalidTool.body.message), /Invalid tool reference/);

    const tooLarge = await fetch(`${baseUrl}/v1/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: "a.b",
        arguments: { value: "x".repeat(200) },
      }),
    });
    assert.equal(tooLarge.status, 413);
  });
});

async function withServer(
  server: Server,
  callback: (baseUrl: string) => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const port = (address as AddressInfo).port;
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function fetchJson(
  url: string,
): Promise<{ status: number; body: JsonObject }> {
  const response = await fetch(url);
  return {
    status: response.status,
    body: (await response.json()) as JsonObject,
  };
}

async function postJson(
  url: string,
  body: JsonObject,
): Promise<{ status: number; body: HttpDecisionResponse & JsonObject }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: (await response.json()) as HttpDecisionResponse & JsonObject,
  };
}
