# Product Overview

## Problem

AI agents are moving from passive assistants to systems that take actions. They can now call APIs, edit repositories, update tickets, send emails, browse authenticated sites, use MCP tools, publish web apps, and initiate commercial workflows.

Most teams do not have a clean way to answer:

- Which tools can this agent use?
- Which tool calls are read-only, write, destructive, external-send, payment-related, or sensitive-data-related?
- Should this call require human approval?
- Was the tool metadata itself safe, or did it contain prompt-injection or hidden instructions?
- What happened during the run, and can a human reconstruct it later?
- Which user, agent, policy, and approval allowed the action?

The existing ecosystem has many ways to build agents, but fewer practical controls for running them safely after they are connected to real tools.

## Product

Warden is a policy and audit layer for agent actions.

The product sits between an agent and anything the agent can cause to happen: a database query, internal API call, MCP tool, billing action, file mutation, or production operation. Before forwarding the action, Warden classifies the request and evaluates it against policy.

The first adapters are:

- a TypeScript guard API for app backends and agent tool wrappers
- an MCP proxy for MCP-compatible clients and upstream MCP servers

## Core Jobs

1. Inventory tools.
   Warden reads tool metadata from adapters, SDK calls, and connected MCP servers.

2. Classify risk.
   Warden labels tools and calls by capability: read, write, destructive, external communication, credential access, financial action, code execution, file mutation, network egress, and sensitive-data exposure.

3. Enforce policy.
   Warden decides whether to allow, deny, or require approval for each tool call.

4. Capture evidence.
   Warden records the agent, user, tool, arguments, policy result, approval state, response summary, timing, and redaction status.

5. Support human approval.
   Warden pauses high-risk calls until a human approves, rejects, or edits the request.

6. Surface anomalies.
   Warden flags unusual patterns such as new tools, changed schemas, suspicious tool descriptions, unexpected destructive calls, high call volume, and data exfiltration-shaped outputs.

## Why Now

The platform layer is changing quickly:

- ChatGPT Sites reduces friction for publishing AI-generated sites and apps.
- ChatGPT Apps and MCP make AI-native distribution easier.
- Codex and similar coding agents can operate local machines and tools.
- Agent builders are becoming easier and more visual.
- Agentic web apps increasingly connect chatbots directly to internal APIs and databases.
- MCP creates one standard tool layer, while SDK and HTTP adapters let Warden cover non-MCP agents.

As the cost of creating agents falls, the value shifts toward making agents safe enough to connect to real systems.

## Buyer

The first buyer is likely a technical founder, staff engineer, platform engineer, or security-minded developer who wants to let agents use real tools but cannot justify broad unrestricted access.

The later buyer is a security/platform team managing many internal agents, MCP servers, and automation workflows across a company.

## Product Shape

### Local Developer Edition

- CLI proxy
- TypeScript guard API
- YAML policies
- local audit log
- terminal approval prompt
- simple web dashboard
- open-source friendly

### Team Edition

- hosted control plane
- shared policy registry
- Slack/Linear/email approvals
- team audit search
- policy templates
- SSO
- compliance export
- production alerting

## Positioning

Warden is "the action firewall for AI agents."

Comparable mental models:

- API gateway for agent tools
- Snyk for risky agent capabilities
- Vercel preview checks for AI-published apps
- Datadog-style traces, but centered on authorization and action evidence

## Differentiation

Observability tools show what happened inside LLM calls and traces. Warden controls whether an action should happen at all.

Agent builders help create workflows. Warden makes those workflows governable.

MCP registries help discover tools. Warden decides whether those tools are safe to use in a specific environment.
