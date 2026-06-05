import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const node = process.execPath;
const wardenCli = join(repoRoot, "dist", "src", "cli", "index.js");
const fakeUpstream = join(
  repoRoot,
  "dist",
  "tests",
  "fixtures",
  "fake-mcp-upstream.js",
);

const tempRoot = mkdtempSync(join(tmpdir(), "warden-client-compat-"));

try {
  const wardenConfig = join(tempRoot, "warden.yaml");
  writeFileSync(wardenConfig, compatibilityPolicy(wardenConfig));

  verifyWardenInspect(wardenConfig);
  verifyCodex(wardenConfig);
  verifyClaude(wardenConfig);

  console.log("client compatibility smoke passed");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function verifyWardenInspect(configPath) {
  const result = run(node, [
    wardenCli,
    "inspect",
    "--config",
    configPath,
    "--json",
  ]);
  const parsed = JSON.parse(result.stdout);
  const names = parsed.tools.map((tool) => tool.name);

  assertIncludes(names, "fixture.read_echo", "Warden inspect read tool");
  assertIncludes(names, "fixture.write_echo", "Warden inspect write tool");
  console.log("ok: warden inspect discovered fixture tools");
}

function verifyCodex(configPath) {
  if (!commandAvailable("codex")) {
    console.log("skip: codex CLI not found");
    return;
  }

  const codexHome = join(tempRoot, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  run("codex", [
    "mcp",
    "add",
    "warden",
    "--",
    node,
    wardenCli,
    "proxy",
    "--config",
    configPath,
  ], {
    env: { CODEX_HOME: codexHome },
  });

  const list = run("codex", ["mcp", "list", "--json"], {
    env: { CODEX_HOME: codexHome },
  });
  const servers = JSON.parse(list.stdout);
  const warden = servers.find((server) => server.name === "warden");

  if (!warden) {
    throw new Error("Codex did not list the Warden MCP server.");
  }
  if (warden.transport?.type !== "stdio") {
    throw new Error("Codex Warden MCP server was not registered as stdio.");
  }
  if (warden.transport.command !== node) {
    throw new Error("Codex Warden MCP server command did not match Node.");
  }

  console.log("ok: codex registered and listed Warden MCP server");
}

function verifyClaude(configPath) {
  if (!commandAvailable("claude")) {
    console.log("skip: claude CLI not found");
    return;
  }

  const claudeProject = join(tempRoot, "claude-project");
  mkdirSync(claudeProject, { recursive: true });

  const serverConfig = JSON.stringify({
    type: "stdio",
    command: node,
    args: [wardenCli, "proxy", "--config", configPath],
  });

  run("claude", ["mcp", "add-json", "-s", "project", "warden", serverConfig], {
    cwd: claudeProject,
  });

  const mcpConfig = JSON.parse(
    readFileSync(join(claudeProject, ".mcp.json"), "utf8"),
  );
  const warden = mcpConfig.mcpServers?.warden;

  if (!warden) {
    throw new Error("Claude did not write the Warden MCP server.");
  }
  if (warden.type !== "stdio" || warden.command !== node) {
    throw new Error("Claude Warden MCP server config did not match stdio Node.");
  }

  const list = run("claude", ["mcp", "list"], { cwd: claudeProject });
  if (!list.stdout.includes("warden:")) {
    throw new Error("Claude did not list the Warden MCP server.");
  }

  console.log("ok: claude registered and listed Warden MCP server");
}

function compatibilityPolicy(configPath) {
  return `defaults:
  read: allow
  write: require_approval
  destructive: require_approval
  external_send: require_approval
  code_execution: require_approval
  file_mutation: require_approval
  network_egress: require_approval
  credential_access: deny
  financial: deny
  sensitive_data: require_approval
  unknown: require_approval

audit:
  path: ${dirname(configPath)}/audit.jsonl

upstreams:
  fixture:
    transport: stdio
    command: ${node}
    args:
      - ${fakeUpstream}
    startup_timeout_ms: 1000
    tool_timeout_ms: 1000
`;
}

function commandAvailable(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return result.status === 0;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${[command, ...args].join(" ")}`,
        `exit: ${String(result.status)}`,
        result.stdout.trim() ? `stdout:\n${result.stdout}` : "",
        result.stderr.trim() ? `stderr:\n${result.stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result;
}

function assertIncludes(values, expected, label) {
  if (!values.includes(expected)) {
    throw new Error(`${label} missing ${expected}. Found: ${values.join(", ")}`);
  }
}
