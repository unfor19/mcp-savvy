# examples/kb-mcp

Protected MCP server backed by a **Bedrock Knowledge Base** over
S3 Vectors. The MCP host (Kiro / Claude Code / Codex) talks to a
**Strands agent** running on AgentCore Runtime; the agent owns
an internal `kb_retrieve` tool and exposes a single outward MCP
tool, `ask(question)`. Its system prompt instructs it to ground
answers solely on the KB and to say so when the KB has nothing
relevant — same pattern as `.vanguard` and `.genia`.

For the **no-LLM-in-the-loop variant** (a Lambda that just
forwards `kb_retrieve` and `kb_retrieve_and_generate` to
`bedrock-agent-runtime`, no agent), see
[`examples/gateway-kb-mcp`](../gateway-kb-mcp).

Both examples share:

- **Cognito** user pool (`@mcp-savvy/cdk` `CognitoAuth`)
- **Bedrock Knowledge Base** (`@mcp-savvy/cdk`
  `BedrockKnowledgeBase`, Titan v2 + S3 Vectors + FIXED_SIZE
  512 + 20% overlap)
- **Corpus** — `examples/_shared/kb-corpus/posts/` (10 markdown
  posts from [meirg.co.il](https://meirg.co.il))
- **Verification queries** — `examples/_shared/kb-corpus/queries.json`

For current status, see the generated
[ARCHITECTURE.md](../../ARCHITECTURE.md) (sourced from this
example's `example.yaml`) and [ARCHITECTURE.md](../../ARCHITECTURE.md).

## Quickstart

```sh
# Default IdP is Cognito.
export MCP_SAVVY_DEMO_IDP=cognito

# Deploy: Cognito + KB + AgentCore Runtime running the agent.
make example-kb-deploy

# Sync the corpus into the source bucket and trigger ingestion.
make example-kb-sync
make example-kb-ingest

# Wire the bridge to your host MCP config and log in.
make example-kb-config
make example-kb-add-user
make example-kb-login

# Run the queries.json smoke test against the deployed agent.
make example-kb-smoke
```

## What's deployed

Three stacks:

- `McpSavvyKbDemoCognito` — Cognito user pool
- `McpSavvyKbDemoKb` — `BedrockKnowledgeBase` (S3 source bucket
  + S3 Vectors + Bedrock KB + DataSource + IAM)
- `McpSavvyKbDemoRuntime` — AgentCore Runtime running the
  agent in `agents/agentic/`

## Corpus replacement

Drop your `.md` files into
`examples/_shared/kb-corpus/posts/`, regenerate `queries.json`,
and re-run `make example-kb-sync` + `make example-kb-ingest`.
Keep the YAML frontmatter shape — the agent uses it for
citations.

## Ground-truth design

The agent's system prompt:

- **Always** call `kb_retrieve` first.
- **Only** answer from `kb_retrieve` results — never from prior
  knowledge.
- If the retrieved chunks don't cover the question, say so
  explicitly (`"I don't have that in the knowledge base."`).
- Cite the source URL from the retrieved chunk metadata.

The smoke test asserts every query in `queries.json` returns
the expected substring; if the agent ever cheats and answers
from training data, the substring won't match the very specific
fragments (`s3:ListAllMyBuckets`, `cc_entrypoint=claude-desktop-3p`,
`s1._domainkey`, etc.) and the test fails loudly.
