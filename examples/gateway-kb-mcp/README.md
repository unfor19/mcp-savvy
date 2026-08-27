# examples/gateway-kb-mcp

Protected MCP server backed by a **Bedrock Knowledge Base**, with
**no LLM in the loop**. An AgentCore Gateway fronts a Lambda target
that forwards two tools straight to the Bedrock Agent Runtime KB
APIs:

| Tool                       | Forwards to                                 | Returns                                   |
| -------------------------- | ------------------------------------------- | ----------------------------------------- |
| `kb_retrieve`              | `bedrock-agent-runtime:Retrieve`            | ranked chunks + source URIs + scores      |
| `kb_retrieve_and_generate` | `bedrock-agent-runtime:RetrieveAndGenerate` | grounded answer + citations (server-side) |

The host LLM (Kiro / Claude Code / Codex) drives RAG: it calls
`kb_retrieve` for raw context and reasons over it itself, or calls
`kb_retrieve_and_generate` to have Bedrock produce a grounded answer
server-side. No agent container, no Strands runtime — the Lambda is
a thin, auth-gated proxy.

**Compare with [`examples/kb-mcp`](../kb-mcp)** — the agentic variant
where a Strands agent on AgentCore Runtime owns retrieval and exposes
a single `ask(question)` tool. Same KB construct, same corpus, same
verification queries; the difference is who orchestrates RAG.

|                     | `kb-mcp` (agentic)                | `gateway-kb-mcp` (this)                                 |
| ------------------- | --------------------------------- | ------------------------------------------------------- |
| Backend             | AgentCore Runtime + Strands agent | AgentCore Gateway + Lambda target                       |
| LLM in the backend? | yes (agent grounds answers)       | no (host LLM drives)                                    |
| Host-facing tools   | `ask(question)`                   | `kb_retrieve`, `kb_retrieve_and_generate`               |
| Cost                | Runtime + per-answer model calls  | Lambda + KB retrieval (+ model only if `_and_generate`) |

Both share:

- **Cognito** user pool (`@mcp-savvy/cdk` `CognitoAuth`)
- **Bedrock Knowledge Base** (`@mcp-savvy/cdk` `BedrockKnowledgeBase`)
- **Corpus** — `examples/_shared/kb-corpus/posts/`
- **Verification queries** — `examples/_shared/kb-corpus/queries.json`

For current status, see the generated
[ARCHITECTURE.md](../../ARCHITECTURE.md) (sourced from this
example's `example.yaml`).

## Quickstart

```sh
export MCP_SAVVY_DEMO_IDP=cognito

make example-gateway-kb-deploy
make example-gateway-kb-sync
make example-gateway-kb-ingest
make example-gateway-kb-config
make example-gateway-kb-add-user EMAIL=<you>
make example-gateway-kb-login
make example-gateway-kb-smoke
```

## What's deployed

Three stacks:

- `McpSavvyGatewayKbDemoCognito` — Cognito user pool
- `McpSavvyGatewayKbDemoKb` — `BedrockKnowledgeBase`
- `McpSavvyGatewayKbDemoGateway` — AgentCore Gateway + the Lambda
  KB target

The Lambda is bundled as **CJS** via `NodejsFunction` so the
`@aws-sdk/client-bedrock-agent-runtime` client (not in the Node 22
runtime's curated SDK set) ships in the zip, and to avoid the
`require('node:https')` ESM trap documented in AGENTS.md.

## Tool-mode pairing

This example pairs naturally with `MCP_SAVVY_TOOL_MODE=passthrough`
(the bridge default) — the host sees `kb___kb_retrieve` and
`kb___kb_retrieve_and_generate` directly. With only two tools there's
no need for search-first flattening. If you front a gateway with many
targets, switch the bridge to `search-local` or `search-gateway`.
