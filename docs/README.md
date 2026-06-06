# Warden Documentation

Warden is a guardrail for OpenAI agents built with `@openai/agents`. It sits between the agent and its tools so risky tool calls can be denied, paused for human approval, and audited.

![Warden OpenAI flow](assets/warden-openai-flow.svg)

## Start Here

- [Quickstart: a new agent](from-scratch.md) — scaffold a runnable, already-guarded agent with `warden init` (Path 1).
- [Quickstart: an existing agent](openai-quickstart.md) — add Warden to a working `@openai/agents` app in about five minutes (Path 2).
- [Migrate an existing agent](migrating-existing-agents.md) — move from direct tool execution to guarded tools without rewriting business logic.

## Reference

- [How Warden works](how-warden-works.md) — the classifier, policy engine, approval flow, executor gate, and audit log.
- [Approval workflow](approval-workflow.md) — Telegram, callback, and deny approval behavior.
- [Security model](security-model.md) — what Warden can and cannot guarantee.
