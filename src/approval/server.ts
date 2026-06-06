import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { JsonObject } from "../domain/types.js";
import {
  expectObject,
  readJsonBody,
  writeError,
  writeHtml,
  writeJson,
} from "../http/util.js";
import type { ApprovalQueue, ResolveOptions } from "./queue.js";

export const DEFAULT_APPROVAL_PORT = 7849;
export const DEFAULT_APPROVAL_HOST = "127.0.0.1";

const MAX_BODY_BYTES = 64 * 1024;
const ACTION_PATTERN = /^\/approvals\/([^/]+)\/(approve|reject|edit)$/;

export function createApprovalServer(options: { queue: ApprovalQueue }): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, options.queue).catch((error) => {
      writeError(response, error);
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  queue: ApprovalQueue,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/") {
    writeHtml(response, 200, INBOX_HTML);
    return;
  }

  if (method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, { status: "ok" });
    return;
  }

  if (method === "GET" && url.pathname === "/approvals") {
    writeJson(response, 200, { approvals: queue.list() });
    return;
  }

  const match = ACTION_PATTERN.exec(url.pathname);
  if (match && method === "POST") {
    const id = decodeURIComponent(match[1] as string);
    const action = match[2] as "approve" | "reject" | "edit";
    const raw = await readJsonBody(request, {
      maxBytes: MAX_BODY_BYTES,
      allowEmpty: true,
    });
    const body = raw === undefined ? {} : expectObject(raw, "request body");
    const resolved = applyAction(queue, id, action, body);

    if (!resolved) {
      writeJson(response, 404, {
        resolved: false,
        error: "not_found",
        message: "No pending approval with that id (it may have expired).",
      });
      return;
    }

    writeJson(response, 200, { resolved: true });
    return;
  }

  writeJson(response, 404, { error: "not_found" });
}

function applyAction(
  queue: ApprovalQueue,
  id: string,
  action: "approve" | "reject" | "edit",
  body: JsonObject,
): boolean {
  const options: ResolveOptions = {};
  const approver = optionalString(body["approver"], "approver");
  const reason = optionalString(body["reason"], "reason");
  if (approver !== undefined) {
    options.approver = approver;
  }
  if (reason !== undefined) {
    options.reason = reason;
  }

  if (action === "approve") {
    return queue.approve(id, options);
  }
  if (action === "reject") {
    return queue.reject(id, options);
  }

  const args = expectObject(body["arguments"] ?? {}, "request body.arguments");
  return queue.edit(id, args, options);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return value;
}

const INBOX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Warden approvals</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; background: #0f1115; color: #e6e6e6; }
  header { padding: 16px 24px; border-bottom: 1px solid #262a33; font-weight: 600; }
  main { padding: 24px; max-width: 760px; margin: 0 auto; }
  .empty { color: #8a8f99; }
  .card { background: #171a21; border: 1px solid #262a33; border-radius: 10px; padding: 16px 18px; margin-bottom: 16px; }
  .tool { font-weight: 600; font-size: 16px; }
  .meta { color: #9aa0ab; font-size: 13px; margin: 4px 0 10px; }
  .risk { display: inline-block; background: #3a2a12; color: #f0b86e; border-radius: 6px; padding: 1px 8px; margin-right: 6px; font-size: 12px; }
  pre { background: #0f1115; border: 1px solid #262a33; border-radius: 8px; padding: 10px; overflow-x: auto; font-size: 13px; }
  button { font: inherit; border: 0; border-radius: 8px; padding: 8px 16px; margin-right: 8px; cursor: pointer; }
  .approve { background: #1f7a3d; color: #fff; }
  .reject { background: #7a2222; color: #fff; }
</style>
</head>
<body>
<header>Warden approvals</header>
<main id="root"><p class="empty">Loading…</p></main>
<script>
const root = document.getElementById("root");
function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"); }
async function load() {
  let approvals = [];
  try {
    const res = await fetch("/approvals");
    approvals = (await res.json()).approvals || [];
  } catch (e) { return; }
  if (approvals.length === 0) {
    root.innerHTML = '<p class="empty">No pending approvals.</p>';
    return;
  }
  root.innerHTML = approvals.map(function (a) {
    const risks = (a.riskLabels || []).map(function (r) { return '<span class="risk">' + esc(r) + '</span>'; }).join("");
    const args = esc(JSON.stringify(a.displayArguments, null, 2));
    const id = esc(a.id);
    return '<div class="card"><div class="tool">' + esc(a.tool) + '</div>' +
      '<div class="meta">' + risks + ' rule: ' + esc(a.policyRule) + ' · expires ' + esc(a.expiresAt) + '</div>' +
      '<pre>' + args + '</pre>' +
      (a.requiresReason ? '<div class="meta">Reason required for approval.</div>' : '') +
      '<button class="approve" data-id="' + id + '" data-action="approve" data-requires-reason="' + (a.requiresReason ? '1' : '0') + '">Approve</button>' +
      '<button class="reject" data-id="' + id + '" data-action="reject">Reject</button></div>';
  }).join("");
}
root.addEventListener("click", async function (e) {
  const btn = e.target.closest("button[data-id]");
  if (!btn) return;
  const body = {};
  if (btn.getAttribute("data-requires-reason") === "1") {
    const reason = prompt("Reason for approval");
    if (!reason) return;
    body.reason = reason;
  }
  await fetch("/approvals/" + encodeURIComponent(btn.getAttribute("data-id")) + "/" + btn.getAttribute("data-action"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  load();
});
load();
setInterval(load, 2000);
</script>
</body>
</html>`;
