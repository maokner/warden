import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runDoctor } from "../src/doctor/doctor.js";

test("runDoctor flags direct Claude Code MCP registrations", () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-doctor-"));

  try {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          warden: { command: "warden" },
          github: { command: "github-mcp-server" },
        },
      }),
    );

    const report = runDoctor(dir);

    assert.equal(report.status, "monitoring_only");
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.code === "direct_mcp_server" &&
          issue.message.includes("github"),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDoctor flags direct Codex MCP registrations", () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-doctor-"));

  try {
    mkdirSync(join(dir, ".codex"));
    writeFileSync(
      join(dir, ".codex", "config.toml"),
      '[mcp_servers.warden]\ncommand = "warden"\n\n[mcp_servers.github]\ncommand = "github-mcp-server"\n',
    );

    const report = runDoctor(dir);

    assert.equal(report.status, "monitoring_only");
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.code === "direct_codex_mcp_server" &&
          issue.message.includes("github"),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDoctor marks clean local scan as partially enforced, not fully enforced", () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-doctor-"));

  try {
    const report = runDoctor(dir);

    assert.equal(report.status, "partially_enforced");
    assert.ok(
      report.issues.some((issue) => issue.code === "enforcement_not_proven"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDoctor flags exposed protected environment variables", () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-doctor-"));

  try {
    const report = runDoctor(dir, {
      env: {
        GITHUB_TOKEN: "ghp_secret",
        PATH: "/usr/bin",
      },
    });

    assert.equal(report.status, "monitoring_only");
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.code === "protected_env_var_exposed" &&
          issue.message.includes("GITHUB_TOKEN"),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
