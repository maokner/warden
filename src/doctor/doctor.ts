import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EnvironmentStatus } from "../domain/types.js";

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
}

const PROTECTED_ENV_PATTERNS = [
  /^GITHUB_TOKEN$/,
  /^GH_TOKEN$/,
  /^GITLAB_TOKEN$/,
  /^SLACK_.*TOKEN$/,
  /^STRIPE_.*(KEY|TOKEN|SECRET)$/,
  /^DATABASE_URL$/,
  /^POSTGRES(_URL|_PASSWORD)?$/,
  /^MYSQL(_URL|_PASSWORD)?$/,
  /^AWS_SECRET_ACCESS_KEY$/,
  /^AWS_ACCESS_KEY_ID$/,
  /^GOOGLE_APPLICATION_CREDENTIALS$/,
  /^OPENAI_API_KEY$/,
  /^ANTHROPIC_API_KEY$/,
  /SECRET/,
  /PRIVATE_KEY/,
  /API_KEY/,
  /ACCESS_TOKEN/,
];

export function runDoctor(cwd: string, options: DoctorOptions = {}): DoctorReport {
  const issues: DoctorIssue[] = [];

  scanMcpConfig(join(cwd, ".mcp.json"), issues, "Claude Code project MCP");
  scanCodexConfig(join(cwd, ".codex", "config.toml"), issues);
  scanEnvironment(options.env ?? {}, issues);

  const localPolicy = join(cwd, "warden.yaml");
  if (existsSync(localPolicy)) {
    issues.push({
      severity: "warning",
      code: "policy_in_workspace",
      path: localPolicy,
      message:
        "warden.yaml is inside the current workspace. Hardened mode should keep policy outside the agent-writable directory.",
    });
  }

  const envPath = join(cwd, ".env");
  if (existsSync(envPath)) {
    issues.push({
      severity: "warning",
      code: "env_in_workspace",
      path: envPath,
      message:
        ".env exists in the workspace. Ensure coding agents cannot read upstream service credentials directly.",
    });
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

function scanEnvironment(
  env: Record<string, string | undefined>,
  issues: DoctorIssue[],
): void {
  for (const [key, value] of Object.entries(env)) {
    if (!value) {
      continue;
    }

    if (!PROTECTED_ENV_PATTERNS.some((pattern) => pattern.test(key))) {
      continue;
    }

    issues.push({
      severity: "critical",
      code: "protected_env_var_exposed",
      message: `${key} is present in the current environment. Warden cannot claim enforcement if the agent process can read upstream credentials directly.`,
    });
  }
}

function scanMcpConfig(
  path: string,
  issues: DoctorIssue[],
  label: string,
): void {
  if (!existsSync(path)) {
    return;
  }

  const content = readFileSync(path, "utf8");
  const directServers = findDirectMcpServers(content);

  for (const server of directServers) {
    issues.push({
      severity: "critical",
      code: "direct_mcp_server",
      path,
      message: `${label} config registers "${server}" directly. Protected tools should be routed through Warden only.`,
    });
  }
}

function scanCodexConfig(path: string, issues: DoctorIssue[]): void {
  if (!existsSync(path)) {
    return;
  }

  const content = readFileSync(path, "utf8");
  const directServers = [...content.matchAll(/\[mcp_servers\.([^\]]+)\]/g)]
    .map((match) => match[1]?.replace(/^"|"$/g, ""))
    .filter((server): server is string => Boolean(server && server !== "warden"));

  for (const server of directServers) {
    issues.push({
      severity: "critical",
      code: "direct_codex_mcp_server",
      path,
      message: `Codex config registers "${server}" directly. Protected tools should be routed through Warden only.`,
    });
  }
}

function findDirectMcpServers(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("mcpServers" in parsed)
    ) {
      return [];
    }

    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (typeof servers !== "object" || servers === null) {
      return [];
    }

    return Object.keys(servers).filter((name) => name !== "warden");
  } catch {
    return [];
  }
}
