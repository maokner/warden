# Product Strategy

## Crisp Problem Statement

AI agents are becoming easy to build and dangerous to operate.

Teams can now connect agents to real tools in minutes, but they lack a simple control layer that answers: what can this agent do, what should require approval, what happened, and who is accountable if it goes wrong?

Warden solves the gap between "agent can call tools" and "agent is safe enough to run against real systems."

## Initial Customer

The initial customer is not a Fortune 500 security committee. It is a developer or small technical team already connecting agents, chatbots, or automation workflows to real databases, internal APIs, SaaS tools, or MCP servers.

They have pain now:

- They want agents to use useful tools, but do not want unrestricted access.
- They are nervous about write/delete/send actions.
- They need a record of tool calls when debugging.
- They do not want to build a policy engine themselves.
- They distrust hosted-only security tooling for sensitive local agent workflows.

## First Use Case

"I want to let my agentic chatbot or workflow use a real database/API, but I need a definitive policy layer that can stop destructive actions before they execute."

This is narrow enough to build and broad enough to matter.

## Why This Can Become a Product

The agent ecosystem creates a control-plane need:

- More agents means more tool calls.
- More connected databases, APIs, and MCP servers means more unknown capabilities.
- More AI-published apps means more accidental privacy and safety risk.
- More autonomy means more demand for approvals, logs, replay, and accountability.

Agent builders compete on creation speed. Warden competes on operational trust.

## Wedge

Start as a local action boundary developers can try in under ten minutes.

The first "wow" moment should be:

1. I wrap a database/API/tool call with Warden.
2. Warden correctly labels risky arguments, including destructive SQL.
3. It blocks or pauses dangerous calls before execution.
4. I can approve a controlled write action intentionally.
5. I get a clean audit log afterward.

## Product Principles

- Fail closed for risky actions.
- Prefer deterministic policy over model judgment.
- Make every decision explainable.
- Keep local-first workflows private.
- Do not require teams to change agent frameworks.
- Do not become an agent builder.
- Optimize for the person who must debug or explain an incident later.

## Business Model

### Free / Open Source

- local proxy
- TypeScript SDK guard
- single-user policy files
- terminal approvals
- local JSONL audit logs
- core classifier

This builds trust and developer adoption.

### Paid Team Product

- hosted approval inbox
- Slack and email approval flows
- shared organization policies
- role-based policy ownership
- searchable audit logs
- tool inventory across teams
- policy drift alerts
- sensitive-data redaction controls
- compliance and incident exports

The paid value is coordination, governance, retention, and reporting.

## Competition

Warden will overlap with several categories but should avoid competing head-on with them.

Observability tools:
They show traces and evals. Warden controls and records action authorization.

Agent builders:
They create agents. Warden governs agents after they can act.

MCP registries:
They help find tools. Warden decides whether tools are safe to use in a specific context.

API gateways:
They secure normal APIs. Warden understands agent-specific risks like tool poisoning, prompt-driven overreach, approval gates, and human-readable audit evidence.

## Milestones

### Milestone 1: Local Proof

Build a CLI that can:

- wrap one protected backend action
- classify action metadata and arguments
- classify risk
- enforce YAML policy
- log calls
- require terminal approval

### Milestone 2: Real Integrations

Test with real app and agent integrations:

- database-backed chatbot
- internal API tool wrapper
- MCP proxy
- external-send tool
- billing/financial action simulator

### Milestone 3: Developer Trust

Add:

- strong docs
- examples
- policy templates
- install guides
- test harness
- security model documentation

### Milestone 4: Team Surface

Add:

- local web UI
- approval inbox
- searchable audit viewer
- shared policies
- hosted sync as optional

### Milestone 5: Expansion

Expand into:

- ChatGPT Sites launch auditor
- MCP supply-chain scanner
- agent replay and regression tests
- organization-wide agent/tool inventory

## Metrics

Early product metrics:

- time to first protected tool call
- number of tools classified correctly
- percent of risky calls caught
- number of approvals completed
- number of blocked calls that users agree were risky
- repeat weekly usage by developers

Team product metrics:

- number of agents behind Warden
- number of tool calls governed
- approval latency
- audit searches per incident/debug session
- number of policy drift events caught
- number of teams using shared policies

## Risks

- MCP clients may support proxying unevenly.
- Agent frameworks may add their own policy layers.
- Developers may resist extra friction.
- Classification could be noisy.
- Hosted audit storage may create privacy concerns.

## Risk Mitigations

- Stay framework-agnostic.
- Start local-first.
- Make approvals configurable and low-friction.
- Let users override classifications.
- Store sensitive payloads locally by default.
- Sell team coordination, not mandatory data ingestion.

## Immediate Next Decision

The next product decision is the first integration target.

Recommended path: build against MCP over stdio first, with a simple filesystem test server. This gives us a contained, testable, real tool surface before we deal with hosted OAuth-heavy tools.
