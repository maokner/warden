import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scrubEnvironment } from "../env/protection.js";

export interface ScrubbedExecEnvironment {
  env: Record<string, string>;
  rootDir: string;
  homeDir: string;
  codexHome: string;
  cleanup: () => void;
}

export function createScrubbedExecEnvironment(options: {
  cwd: string;
  configPath: string;
  env: Record<string, string | undefined>;
}): ScrubbedExecEnvironment {
  const rootDir = mkdtempSync(join(tmpdir(), "warden-exec-"));
  const homeDir = join(rootDir, "home");
  const codexHome = join(rootDir, "codex");
  const xdgConfigHome = join(rootDir, "xdg");
  const codexDotDir = join(homeDir, ".codex");
  const claudeDotDir = join(homeDir, ".claude");
  const resolvedConfigPath = resolve(options.cwd, options.configPath);

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(xdgConfigHome, { recursive: true });
  mkdirSync(codexDotDir, { recursive: true });
  mkdirSync(claudeDotDir, { recursive: true });

  const codexConfig = codexConfigText(resolvedConfigPath);
  writeFileSync(join(codexHome, "config.toml"), codexConfig);
  writeFileSync(join(codexDotDir, "config.toml"), codexConfig);

  const claudeConfig = claudeConfigText(resolvedConfigPath);
  writeFileSync(join(homeDir, ".mcp.json"), claudeConfig);
  writeFileSync(join(homeDir, ".claude.json"), claudeConfig);
  writeFileSync(join(claudeDotDir, "settings.json"), claudeConfig);
  writeFileSync(join(claudeDotDir, "mcp.json"), claudeConfig);

  const env = scrubEnvironment(options.env);
  env["HOME"] = homeDir;
  env["USERPROFILE"] = homeDir;
  env["CODEX_HOME"] = codexHome;
  env["XDG_CONFIG_HOME"] = xdgConfigHome;
  env["WARDEN_EXEC"] = "1";
  env["WARDEN_CONFIG"] = resolvedConfigPath;

  return {
    env,
    rootDir,
    homeDir,
    codexHome,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

function codexConfigText(configPath: string): string {
  return `[mcp_servers.warden]
command = "warden"
args = ["proxy", "--config", "${escapeTomlString(configPath)}"]
default_tools_approval_mode = "approve"
`;
}

function claudeConfigText(configPath: string): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        warden: {
          type: "stdio",
          command: "warden",
          args: ["proxy", "--config", configPath],
        },
      },
    },
    null,
    2,
  )}
`;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
