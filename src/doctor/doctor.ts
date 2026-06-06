import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { EnvironmentStatus } from "../domain/types.js";
import { isProtectedEnvName } from "../env/protection.js";

export interface DoctorIssue {
  severity: "info" | "warning" | "critical";
  code: string;
  message: string;
  path?: string;
}

export interface DoctorReport {
  status: EnvironmentStatus;
  issues: DoctorIssue[];
}

export interface DoctorOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  policyPath?: string;
  auditPath?: string;
  protectedHostnames?: string[];
  maxWorkspaceFiles?: number;
}

const ENV_FILE_NAMES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
];

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".warden",
  "__tests__",
  "example",
  "examples",
  "test",
  "tests",
]);

const SCANNED_EXTENSIONS = new Set([
  ".cjs",
  ".conf",
  ".env",
  ".go",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".py",
  ".rb",
  ".ts",
  ".tsx",
  ".toml",
  ".yaml",
  ".yml",
]);

const MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_WORKSPACE_FILES = 2_000;
const MAX_BYPASS_FINDINGS = 25;

const DEFAULT_PROTECTED_HOSTNAMES = [
  ["api", "openai.com"].join("."),
  ["api", "anthropic.com"].join("."),
  ["api", "stripe.com"].join("."),
  ["hooks", "slack.com"].join("."),
  ["slack.com", "api"].join("/"),
  ["api", "github.com"].join("."),
  [".rds", "amazonaws.com"].join("."),
  [".supabase", "co"].join("."),
  [".neon", "tech"].join("."),
  ["planetscale", "com"].join("."),
  "localhost:5432",
  "127.0.0.1:5432",
  "localhost:3306",
  "127.0.0.1:3306",
];

const DIRECT_SDK_PATTERNS: Array<{ name: string; patterns: RegExp[] }> = [
  jsPackage("openai"),
  jsPackage("@anthropic-ai/sdk"),
  jsPackage("stripe"),
  jsPackage("twilio"),
  jsPackage("pg"),
  jsPackage("postgres"),
  jsPackage("mysql"),
  jsPackage("mysql2"),
  jsPackage("mongodb"),
  jsPackage("redis"),
  jsPackage("@aws-sdk/client-secrets-manager"),
  jsPackage("@aws-sdk/client-rds"),
  jsPackage("@google-cloud/secret-manager"),
  pyPackage("openai"),
  pyPackage("anthropic"),
  pyPackage("stripe"),
  pyPackage("twilio"),
  pyPackage("psycopg2"),
  pyPackage("sqlalchemy"),
  pyPackage("pymongo"),
  pyPackage("redis"),
  pyPackage("boto3"),
];

export function runDoctor(cwd: string, options: DoctorOptions = {}): DoctorReport {
  const root = resolve(cwd);
  const issues: DoctorIssue[] = [];
  const env = options.env ?? {};

  scanMcpConfig(
    join(root, ".mcp.json"),
    issues,
    "Claude Code project MCP",
    "direct_mcp_server",
  );
  scanCodexConfig(
    join(root, ".codex", "config.toml"),
    issues,
    "Codex project config",
    "direct_codex_mcp_server",
  );
  scanUserConfigs(options.homeDir ?? env["HOME"], issues);
  scanEnvironment(env, issues);
  scanEnvFiles(root, issues);
  scanWorkspaceBypassPaths(root, issues, {
    protectedHostnames:
      options.protectedHostnames ?? DEFAULT_PROTECTED_HOSTNAMES,
    maxFiles: options.maxWorkspaceFiles ?? DEFAULT_MAX_WORKSPACE_FILES,
  });

  const localPolicy = join(root, "warden.yaml");
  if (existsSync(localPolicy)) {
    issues.push({
      severity: "warning",
      code: "policy_in_workspace",
      path: localPolicy,
      message:
        "warden.yaml is inside the current workspace. Hardened mode should keep policy outside the agent-writable directory.",
    });
  }

  if (options.policyPath) {
    scanControlPath(root, resolve(root, options.policyPath), "policy", issues);
  }

  if (options.auditPath) {
    scanControlPath(root, resolve(root, options.auditPath), "audit", issues);
  }

  issues.push({
    severity: "info",
    code: "enforcement_not_proven",
    message:
      "Local doctor cannot prove credential ownership or network isolation yet, so the setup is not marked enforced.",
  });

  return {
    status: issues.some((issue) => issue.severity === "critical")
      ? "monitoring_only"
      : "partially_enforced",
    issues,
  };
}

function scanUserConfigs(
  homeDir: string | undefined,
  issues: DoctorIssue[],
): void {
  if (!homeDir) {
    return;
  }

  scanCodexConfig(
    join(homeDir, ".codex", "config.toml"),
    issues,
    "Codex user config",
    "direct_user_codex_mcp_server",
  );
  scanMcpConfig(
    join(homeDir, ".mcp.json"),
    issues,
    "user-level MCP",
    "direct_user_mcp_server",
  );
  scanMcpConfig(
    join(homeDir, ".claude.json"),
    issues,
    "Claude user config",
    "direct_user_claude_mcp_server",
  );
  scanMcpConfig(
    join(homeDir, ".claude", "settings.json"),
    issues,
    "Claude user settings",
    "direct_user_claude_mcp_server",
  );
  scanMcpConfig(
    join(homeDir, ".claude", "mcp.json"),
    issues,
    "Claude user MCP",
    "direct_user_claude_mcp_server",
  );
}

function scanEnvironment(
  env: Record<string, string | undefined>,
  issues: DoctorIssue[],
): void {
  for (const [key, value] of Object.entries(env)) {
    if (!value || !isProtectedEnvName(key)) {
      continue;
    }

    issues.push({
      severity: "critical",
      code: "protected_env_var_exposed",
      message: `${key} is present in the current environment. Warden cannot claim enforcement if the agent process can read upstream credentials directly.`,
    });
  }
}

function scanEnvFiles(root: string, issues: DoctorIssue[]): void {
  for (const fileName of ENV_FILE_NAMES) {
    const envPath = join(root, fileName);
    if (!existsSync(envPath)) {
      continue;
    }

    issues.push({
      severity: "warning",
      code: "env_in_workspace",
      path: envPath,
      message:
        `${fileName} exists in the workspace. Ensure coding agents cannot read upstream service credentials directly.`,
    });

    const content = safeReadText(envPath);
    if (!content) {
      continue;
    }

    for (const key of findProtectedEnvKeys(content)) {
      issues.push({
        severity: "critical",
        code: "protected_env_file_entry",
        path: envPath,
        message: `${fileName} contains ${key}. Warden cannot claim enforcement if the agent can read credential files directly.`,
      });
    }
  }
}

function scanMcpConfig(
  path: string,
  issues: DoctorIssue[],
  label: string,
  code: string,
): void {
  if (!existsSync(path)) {
    return;
  }

  const content = safeReadText(path);
  if (!content) {
    return;
  }

  const directServers = findDirectMcpServers(content);

  for (const server of directServers) {
    issues.push({
      severity: "critical",
      code,
      path,
      message: `${label} config registers "${server}" directly. Protected tools should be routed through Warden only.`,
    });
  }
}

function scanCodexConfig(
  path: string,
  issues: DoctorIssue[],
  label: string,
  code: string,
): void {
  if (!existsSync(path)) {
    return;
  }

  const content = safeReadText(path);
  if (!content) {
    return;
  }

  const directServers = [...content.matchAll(/\[mcp_servers\.([^\]]+)\]/g)]
    .map((match) => match[1]?.replace(/^"|"$/g, ""))
    .filter((server): server is string => Boolean(server && server !== "warden"));

  for (const server of directServers) {
    issues.push({
      severity: "critical",
      code,
      path,
      message: `${label} registers "${server}" directly. Protected tools should be routed through Warden only.`,
    });
  }
}

function scanWorkspaceBypassPaths(
  root: string,
  issues: DoctorIssue[],
  options: { protectedHostnames: string[]; maxFiles: number },
): void {
  const findings: DoctorIssue[] = [];
  let scannedFiles = 0;
  let truncated = false;

  const scan = (dir: string): void => {
    if (scannedFiles >= options.maxFiles) {
      truncated = true;
      return;
    }

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (findings.length >= MAX_BYPASS_FINDINGS) {
        truncated = true;
        return;
      }

      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          scan(path);
        }
        continue;
      }

      if (!entry.isFile() || !shouldScanFile(path)) {
        continue;
      }

      scannedFiles += 1;
      if (scannedFiles > options.maxFiles) {
        truncated = true;
        return;
      }

      const content = safeReadText(path);
      if (!content) {
        continue;
      }

      collectDirectSdkFindings(root, path, content, findings);
      collectProtectedHostnameFindings(
        root,
        path,
        content,
        options.protectedHostnames,
        findings,
      );
    }
  };

  scan(root);
  issues.push(...findings);

  if (truncated) {
    issues.push({
      severity: "info",
      code: "workspace_bypass_scan_truncated",
      message:
        "Workspace bypass scan hit its file or finding limit. Rerun with a narrower workspace if you need complete coverage.",
    });
  }
}

function collectDirectSdkFindings(
  root: string,
  path: string,
  content: string,
  findings: DoctorIssue[],
): void {
  for (const sdk of DIRECT_SDK_PATTERNS) {
    if (!sdk.patterns.some((pattern) => pattern.test(content))) {
      continue;
    }

    findings.push({
      severity: "warning",
      code: "direct_sdk_import",
      path,
      message: `${relative(root, path)} imports ${sdk.name} directly. Agent-editable code can bypass Warden if it can call protected SDKs with credentials.`,
    });
  }
}

function collectProtectedHostnameFindings(
  root: string,
  path: string,
  content: string,
  protectedHostnames: string[],
  findings: DoctorIssue[],
): void {
  const normalized = content.toLowerCase();

  for (const hostname of protectedHostnames) {
    if (!hostname || !normalized.includes(hostname.toLowerCase())) {
      continue;
    }

    findings.push({
      severity: "warning",
      code: "protected_hostname_reference",
      path,
      message: `${relative(root, path)} references ${hostname}. Direct protected egress paths should be routed through Warden-owned tools or removed from agent-reachable code.`,
    });
  }
}

function scanControlPath(
  root: string,
  targetPath: string,
  kind: "policy" | "audit",
  issues: DoctorIssue[],
): void {
  const parent = dirname(targetPath);

  if (isInside(root, targetPath)) {
    issues.push({
      severity: "warning",
      code: `${kind}_path_in_workspace`,
      path: targetPath,
      message: `Configured ${kind} path is inside the agent workspace. Hardened mode should store ${kind} state outside agent-writable files.`,
    });
  }

  if (canWrite(targetPath) || canWrite(parent)) {
    issues.push({
      severity: "warning",
      code: `${kind}_path_writable`,
      path: targetPath,
      message: `Configured ${kind} path is writable by the current user. This is expected locally, but it means Warden cannot prove tamper resistance for that ${kind} file.`,
    });
  }
}

function findDirectMcpServers(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as unknown;
    return [...findMcpServersInValue(parsed)];
  } catch {
    return [];
  }
}

function findMcpServersInValue(value: unknown): Set<string> {
  const servers = new Set<string>();

  if (Array.isArray(value)) {
    for (const entry of value) {
      for (const server of findMcpServersInValue(entry)) {
        servers.add(server);
      }
    }
    return servers;
  }

  if (typeof value !== "object" || value === null) {
    return servers;
  }

  const object = value as Record<string, unknown>;
  const mcpServers = object["mcpServers"];
  if (typeof mcpServers === "object" && mcpServers !== null) {
    for (const name of Object.keys(mcpServers)) {
      if (name !== "warden") {
        servers.add(name);
      }
    }
  }

  for (const nested of Object.values(object)) {
    for (const server of findMcpServersInValue(nested)) {
      servers.add(server);
    }
  }

  return servers;
}

function findProtectedEnvKeys(content: string): string[] {
  const keys = new Set<string>();

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const key = match?.[1];
    if (key && isProtectedEnvName(key)) {
      keys.add(key);
    }
  }

  return [...keys];
}

function shouldScanFile(path: string): boolean {
  const extension = extname(path).toLowerCase();
  if (!SCANNED_EXTENSIONS.has(extension)) {
    return ENV_FILE_NAMES.some((name) => path.endsWith(name));
  }

  try {
    return lstatSync(path).isFile() && statSync(path).size <= MAX_FILE_BYTES;
  } catch {
    return false;
  }
}

function safeReadText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function canWrite(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isInside(root: string, targetPath: string): boolean {
  const relativePath = relative(root, targetPath);
  return (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !isAbsolute(relativePath)
  );
}

function jsPackage(name: string): { name: string; patterns: RegExp[] } {
  const escaped = escapeRegExp(name);
  return {
    name,
    patterns: [
      new RegExp(`\\bfrom\\s+["']${escaped}(?:/[^"']*)?["']`),
      new RegExp(`\\brequire\\(\\s*["']${escaped}(?:/[^"']*)?["']\\s*\\)`),
      new RegExp(`\\bimport\\(\\s*["']${escaped}(?:/[^"']*)?["']\\s*\\)`),
    ],
  };
}

function pyPackage(name: string): { name: string; patterns: RegExp[] } {
  const escaped = escapeRegExp(name);
  return {
    name,
    patterns: [
      new RegExp(`(^|\\n)\\s*import\\s+${escaped}(?:\\s|\\.|$)`),
      new RegExp(`(^|\\n)\\s*from\\s+${escaped}(?:\\s|\\.|$)`),
    ],
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
