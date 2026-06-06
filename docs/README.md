# Warden Documentation

Warden is for app-built agents that can take real actions: send messages, update databases, trigger workflows, call APIs, or move money. It sits between the agent and those tools so risky actions can be denied, approved in Telegram, and audited.

![Warden OpenAI flow](assets/warden-openai-flow.svg)

## Start Here

- [OpenAI Agents SDK quickstart](openai-quickstart.md) - add Warden to an existing `@openai/agents` app in about five minutes.
- [Migrate an existing agent](migrating-existing-agents.md) - how to move from direct tool execution to guarded tools without rewriting business logic.
- [How Warden works](how-warden-works.md) - the classifier, policy engine, approval flow, executor gate, and audit log.
- [Integration surfaces](integration-surfaces.md) - when to use OpenAI `guardTools`, generic `guard`, MCP gateway, or the HTTP sidecar.

## Reference

- [Approval workflow](approval-workflow.md) - local, Telegram, and callback approval behavior.
- [MCP gateway](mcp-gateway.md) - stdio MCP proxy behavior and limits.
- [Security model](security-model.md) - what Warden can and cannot guarantee for app-built agents.
