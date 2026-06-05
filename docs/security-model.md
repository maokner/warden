# Security Model

## Core Security Claim

Warden can prevent agent bypass only when it controls the credentials, network path, and tool boundary.

Warden cannot reliably protect an upstream tool if the agent can also reach that tool directly with the same user's credentials, environment variables, browser session, shell access, or MCP configuration.

This must be explicit in the product. Warden is not a prompt-level safety layer. It is a control boundary.

## Threat Model

Assume a coding agent may be able to:

- read and edit files in the project
- modify MCP client configuration files
- run shell commands
- install packages
- call external APIs over the network
- inspect environment variables
- read local config files
- generate code that bypasses Warden at runtime
- modify tests, scripts, or deployment config
- attempt to hide direct API usage in code changes

Warden should treat the agent as an untrusted writer inside the workspace.

## Main Bypass Paths

### Direct MCP Registration

The agent edits the MCP client config to add the upstream MCP server directly.

Example risk:

```json
{
  "mcpServers": {
    "github-direct": {
      "command": "npx",
      "args": ["@modelcontextprotocol/server-github"]
    }
  }
}
```

Control:

- Warden should provide a config scanner that flags direct MCP registrations for protected integrations.
- Hardened mode should run the agent in an environment where MCP config files are not writable.
- Team mode should distribute locked MCP configuration through managed device or workspace policy.

### Direct API Calls

The agent installs an SDK or writes code that calls GitHub, Slack, Gmail, Stripe, databases, or internal services directly.

Control:

- Do not expose upstream API keys in the agent environment.
- Restrict network egress from the agent sandbox.
- Route protected service access through Warden-controlled service accounts.
- Add code scanning for protected SDKs, hostnames, and env vars.

### Secret Theft

The agent reads `.env`, shell profiles, keychain material, cloud credentials, OAuth tokens, or local app credentials.

Control:

- Keep production credentials outside the workspace.
- Launch the agent with a minimal environment.
- Use separate OS users or containers for agent execution.
- Never mount host credential directories into the agent sandbox.
- Store upstream credentials in Warden, not in the project.

### Policy Tampering

The agent edits Warden policy files to allow a blocked tool.

Control:

- Policy files must live outside the agent-writable workspace in hardened mode.
- Policy versions should be hashed and signed.
- Every policy change should be auditable.
- Team policy changes should require human review.

### Audit Tampering

The agent deletes or edits local audit logs.

Control:

- Logs should be append-only where possible.
- Hardened mode should write logs outside the workspace.
- Team mode should stream audit events to a remote append-only store.
- Local log gaps should be treated as suspicious.

### Generated Runtime Bypass

The agent writes application code that bypasses Warden after deployment.

Control:

- Add CI checks for protected service SDKs, direct API hosts, and sensitive env vars.
- Require a Warden deployment audit before production deploy.
- Prefer runtime service credentials that only Warden can use.
- Use network policy so production apps cannot reach protected services except through approved gateways.

## Protection Tiers

### Tier 0: Soft Local Mode

Useful for adoption and visibility, but not strong prevention.

Capabilities:

- scan MCP client configs
- detect direct upstream registrations
- warn about exposed env vars
- log all proxied calls
- provide setup guidance

Limits:

- an agent with unrestricted shell, file, credentials, and network access can bypass Warden

### Tier 1: Hardened Local Mode

Useful for developers who want real local enforcement.

Capabilities:

- Warden runs outside the project workspace
- upstream MCP servers are spawned only by Warden
- upstream credentials live only in Warden's environment or OS credential store
- agent process receives a minimal environment
- policy and logs live outside the writable workspace
- known MCP config paths are read-only or watched

This tier reduces accidental and opportunistic bypass, but host-level access can still be hard to constrain perfectly on a personal machine.

### Tier 2: Sandboxed Agent Mode

The preferred prevention model for coding agents.

Architecture:

```text
Host Machine
  |
  +-- Warden Daemon
  |     +-- upstream credentials
  |     +-- upstream MCP servers
  |     +-- policy
  |     +-- audit logs
  |
  +-- Agent Sandbox
        +-- project workspace mount
        +-- Warden MCP endpoint only
        +-- no upstream credentials
        +-- restricted network egress
        +-- no host credential mounts
```

In this mode, the agent can edit project code, but it cannot directly reach protected tools or credentials.

### Tier 3: Team / Production Mode

The strongest commercial product surface.

Capabilities:

- Warden-hosted or self-hosted gateway
- service credentials stored only in Warden
- private network access to upstream systems
- SSO and role-based policy ownership
- remote append-only audit storage
- managed approval workflows
- deployment checks
- egress allowlists
- organization-wide direct-access detection

This is where Warden becomes a real governance product instead of only a developer tool.

## Product Features Needed

### `warden doctor`

Scans the local environment for bypass risks:

- direct MCP configs
- exposed protected API keys
- known SDK credentials
- writable Warden policy files
- writable audit log paths
- unrestricted network access warnings
- risky MCP servers registered outside Warden

### `warden lock`

Creates a hardened local setup:

- moves policy outside the project
- creates protected audit log directory
- generates MCP client config that points only to Warden
- warns about direct upstream credentials
- optionally sets file permissions where supported

### `warden exec`

Runs an agent command inside a constrained environment:

```bash
warden exec -- codex
warden exec -- claude
warden exec -- cursor-agent
```

Expected behavior:

- strips protected env vars
- injects only Warden MCP config
- sets a clean home/config directory
- blocks access to host credential paths where possible
- optionally starts a containerized sandbox

### `warden scan-code`

Scans code changes for generated bypass paths:

- direct calls to protected API hosts
- imports of protected service SDKs
- use of protected env vars
- raw webhook URLs
- hardcoded tokens
- suspicious generated MCP config files

This should integrate with pre-commit and CI.

### `warden attest`

Records a signed snapshot of:

- upstream tool inventory
- policy version
- Warden version
- allowed integrations
- detected direct-access risks

This gives teams evidence that an agent run or deployment used the expected control boundary.

## Default Product Rule

If the user wants enforcement, Warden must own these three things:

1. Credentials
2. Network access
3. Policy and audit storage

If any of those are still controlled by the agent, Warden should mark the environment as "monitoring only" instead of "enforced."

