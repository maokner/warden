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

test("runDoctor flags user-level Codex and Claude MCP bypasses", () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-doctor-"));
  const home = mkdtempSync(join(tmpdir(), "warden-home-"));

  try {
    mkdirSync(join(home, ".codex"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".codex", "config.toml"),
      '[mcp_servers.warden]\ncommand = "warden"\n\n[mcp_servers.github]\ncommand = "github-mcp-server"\n',
    );
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        projects: {
          "/repo": {
            mcpServers: {
              warden: { command: "warden" },
              postgres: { command: "postgres-mcp" },
            },
          },
        },
      }),
    );

    const report = runDoctor(dir, { homeDir: home });

    assert.equal(report.status, "monitoring_only");
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.code === "direct_user_codex_mcp_server" &&
          issue.message.includes("github"),
      ),
    );
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.code === "direct_user_claude_mcp_server" &&
          issue.message.includes("postgres"),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("runDoctor flags direct SDK imports and protected hostnames", () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-doctor-"));

  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "src", "client.ts"),
      'import OpenAI from "openai";\nconst url = "https://api.openai.com/v1/responses";\n',
    );

    const report = runDoctor(dir);

    assert.equal(report.status, "partially_enforced");
    assert.ok(
      report.issues.some((issue) => issue.code === "direct_sdk_import"),
    );
    assert.ok(
      report.issues.some(
        (issue) => issue.code === "protected_hostname_reference",
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDoctor flags protected entries in env files", () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-doctor-"));

  try {
    writeFileSync(join(dir, ".env.local"), "OPENAI_API_KEY=sk-test\n");

    const report = runDoctor(dir);

    assert.equal(report.status, "monitoring_only");
    assert.ok(report.issues.some((issue) => issue.code === "env_in_workspace"));
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.code === "protected_env_file_entry" &&
          issue.message.includes("OPENAI_API_KEY"),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDoctor flags policy and audit paths that are inside writable workspace", () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-doctor-"));

  try {
    writeFileSync(join(dir, "warden.yaml"), "defaults: {}\n");
    mkdirSync(join(dir, ".warden"));

    const report = runDoctor(dir, {
      policyPath: join(dir, "warden.yaml"),
      auditPath: join(dir, ".warden", "audit.jsonl"),
    });

    assert.equal(report.status, "partially_enforced");
    assert.ok(
      report.issues.some((issue) => issue.code === "policy_path_in_workspace"),
    );
    assert.ok(
      report.issues.some((issue) => issue.code === "audit_path_in_workspace"),
    );
    assert.ok(
      report.issues.some((issue) => issue.code === "policy_path_writable"),
    );
    assert.ok(
      report.issues.some((issue) => issue.code === "audit_path_writable"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
