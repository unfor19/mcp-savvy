# mcp-savvy — Architecture & Examples

> Auto-generated from `examples/*/example.yaml` and
> `examples/_shared/architecture/overview.yaml` by
> `scripts/gen-architecture.mjs`. Do not edit by hand — run
> `make architecture` after changing an example or its metadata.

A single page for handing someone the *what* and the *why*: the
purpose, the deployment shapes mcp-savvy covers, and every example
on the grid. For the quickstart see [README.md](./README.md);
for detailed capabilities see [FEATURES.md](./FEATURES.md).

## Purpose

mcp-savvy is the expert MCP deployer, so you only deal with your app. It ships protected MCP servers on AWS without copy-pasting auth, infra, and a stdio bridge into every new repo — distilled from several production deployments that all rebuilt the same plumbing: OIDC PKCE, OS-keychain token storage, a hardened local callback server, a stdio ↔ Streamable-HTTP bridge, and CDK infra for Cognito + AgentCore.

There are two consumers. End users run the published CLI as a stdio bridge (same UX as mcp-remote, with auth baked in) — one `npx` line in their MCP client config, no AWS account required. MCP authors import the CDK constructs to stand up the backend: Cognito + AgentCore Runtime or Gateway, secure by default, cdk-nag clean.

The examples below are the proof. Each deploys end-to-end to a sandbox AWS account with a single `make` target and uses the same mcp-savvy client (no per-example bridges). Identity-provider coverage is listed explicitly for each example.

## The architecture matrix

Three backend surfaces (Runtime hosts your code; Gateway exposes other
people's APIs as MCP tools; Lambda MCP hosts the MCP server in a plain
Lambda for cases where AgentCore is overkill or VPC isolation is the
point) crossed with whether the backend is called directly or behind a
REST API front door.

- **Backend axis** — Runtime hosts your code (a Strands agent or any MCP server in a container); Gateway exposes other people's APIs (Lambda, OpenAPI, Smithy) as MCP tools; Lambda MCP hosts the MCP server in a plain Lambda when AgentCore is overkill or when VPC isolation is the point. The first two map to AgentCore's two MCP product surfaces; the third covers the bring-your-own-Lambda story.
- **Fronting axis** — Direct calls AgentCore straight (cheapest, smallest blast radius); the REST API front door adds WAF, throttling, IP allowlists, and a custom domain. The fronting choice is independent of the backend. Only REST API is shipped — HTTP API's native JWT authorizer is Cognito-only and would silently break Entra/Okta/Auth0.

|                       | **Direct** | **REST API front door** |
| --------------------- | ---------- | ----------------------- |
| **AgentCore Runtime** | (A) [`minimal-mcp`](./examples/minimal-mcp) ✅ validated<br>(A2) [`kb-mcp`](./examples/kb-mcp) ✅ validated | — |
| **AgentCore Gateway** | (B) [`gateway-kb-mcp`](./examples/gateway-kb-mcp) ✅ validated<br>(B) [`gateway-lambda-mcp`](./examples/gateway-lambda-mcp) ✅ validated<br>(C) [`gateway-3lo-mcp`](./examples/gateway-3lo-mcp) ✅ validated | — |
| **Lambda MCP**        | — | (G) [`chatgpt-app-mcp`](./examples/chatgpt-app-mcp) ✅ validated |

Identity support varies by example and is listed in each entry below.
The toolkit also supports external OIDC providers — see [identity providers](#identity-providers).

## How a request flows

```
MCP client (Kiro / Claude Code / Codex / any MCP host)
            │ stdio (JSON-RPC)
            ▼
┌───────────────────────────────────────────────────┐
│  npx -y mcp-savvy                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐      │
│  │ Stdio    │◄►│ Auth     │◄►│ Token store  │      │
│  │ bridge   │  │ provider │  │ (keychain or │      │
│  │ +        │  │ (OIDC)   │  │  enc-file)   │      │
│  │ search-  │  └────┬─────┘  └──────────────┘      │
│  │ first    │       │ PKCE                         │
│  │ + 3LO    │       ▼                              │
│  │ orchestr.│  ┌─────────────────┐                 │
│  │          │  │ Local callback  │ ← branded       │
│  │          │  │ servers         │   success page  │
│  │          │  │ (33423 + 33424) │                 │
│  └────┬─────┘  └─────────────────┘                 │
└───────┼───────────────────────────────────────────┘
        │ Streamable HTTP, Bearer JWT
        ▼
   AgentCore Runtime  /  AgentCore Gateway  /  any protected MCP
       (your @mcp-savvy/cdk-deployed backend)
```

## Examples

### (A) Minimal MCP — `minimal-mcp`

✅ validated — live on Cognito + Entra (2026-05-27)

The smallest possible protected MCP — Cognito + AgentCore Runtime running a one-tool echo agent. Validates the client without any extra moving parts.

Start here. It's the reference shape every other example builds on: a JWT user pool in front of an AgentCore Runtime, reached through the mcp-savvy bridge.

- **Shape**: AgentCore Runtime · Direct (no front door)
- **Constructs**: `CognitoAuth`, `AgentCoreRuntime`
- **Identity**: Cognito, Entra ID
- **Tool mode**: `passthrough`
- **Deploy**: `make example-minimal-deploy`

| Host-facing tool | What it does |
| --- | --- |
| `echo` | Returns its input — proves the authenticated round-trip end to end. |

| Stack | Purpose |
| --- | --- |
| `McpSavvyDemoCognito` | Cognito user pool (MFA TOTP, managed login, branding). |
| `McpSavvyDemoRuntime` | AgentCore Runtime running the echo agent, gated by the pool's JWT. |

Compare with: [`kb-mcp`](./examples/kb-mcp).

### (A2) Knowledge-Base MCP (agentic) — `kb-mcp`

✅ validated — KB + retrieval live (20/20); interactive agent-grounding smoke pending

A Strands agent on AgentCore Runtime grounded on a Bedrock Knowledge Base. Exposes one outward tool, ask(question); the agent owns retrieval and refuses when the KB has nothing relevant.

The team-internal knowledge base over MCP. The agent always retrieves first, answers solely from retrieved chunks, and cites source URLs — the same grounding discipline as .vanguard / .genia.

- **Shape**: AgentCore Runtime · Direct (no front door)
- **Constructs**: `CognitoAuth`, `BedrockKnowledgeBase`, `AgentCoreRuntime`
- **Identity**: Cognito, Entra ID
- **Tool mode**: `passthrough`
- **Deploy**: `make example-kb-deploy`

| Host-facing tool | What it does |
| --- | --- |
| `ask` | Answers a question strictly from the KB, with citations, or says it can't. |

| Stack | Purpose |
| --- | --- |
| `McpSavvyKbDemoCognito` | Cognito user pool. |
| `McpSavvyKbDemoKb` | BedrockKnowledgeBase — S3 source bucket + S3 Vectors + KB + DataSource + IAM. |
| `McpSavvyKbDemoRuntime` | AgentCore Runtime running the Strands agent in agents/agentic/. |

Compare with: [`gateway-kb-mcp`](./examples/gateway-kb-mcp).

### (B) Knowledge-Base MCP (no LLM) — `gateway-kb-mcp`

✅ validated — both Lambda tools live-validated (2026-05-31); interactive smoke pending

The same Bedrock Knowledge Base fronted by an AgentCore Gateway Lambda target — no agent. The Lambda forwards two tools straight to the Bedrock Agent Runtime; the host LLM drives RAG.

The no-LLM-in-the-loop variant of kb-mcp. Use kb_retrieve for raw context the host reasons over, or kb_retrieve_and_generate for a server-side grounded answer. Cheaper and simpler when you don't need an agent.

- **Shape**: AgentCore Gateway · Direct (no front door)
- **Constructs**: `CognitoAuth`, `BedrockKnowledgeBase`, `AgentCoreGateway`
- **Identity**: Cognito, Entra ID
- **Tool mode**: `passthrough`
- **Deploy**: `make example-gateway-kb-deploy`

| Host-facing tool | What it does |
| --- | --- |
| `kb_retrieve` | Forwards to bedrock-agent-runtime Retrieve — ranked chunks + source URIs. |
| `kb_retrieve_and_generate` | Forwards to RetrieveAndGenerate — grounded answer + citations, server-side. |

| Stack | Purpose |
| --- | --- |
| `McpSavvyGatewayKbDemoCognito` | Cognito user pool. |
| `McpSavvyGatewayKbDemoKb` | BedrockKnowledgeBase — shared across IdP variants. |
| `McpSavvyGatewayKbDemoGateway` | AgentCore Gateway + the CJS-bundled Lambda KB target. |

Compare with: [`kb-mcp`](./examples/kb-mcp).

### (B) Gateway + Lambda MCP — `gateway-lambda-mcp`

✅ validated — live on Cognito + Entra (2026-05-27)

Expose existing Lambda functions as MCP tools through an AgentCore Gateway, without touching the agent layer. Two trivial tools demonstrate the shape.

You already have Lambdas and want them reachable as auth-gated MCP tools. The Gateway invokes the Lambdas over IAM; the end user authenticates against Cognito to reach the Gateway. No OAuth dance for the tools themselves.

- **Shape**: AgentCore Gateway · Direct (no front door)
- **Constructs**: `CognitoAuth`, `AgentCoreGateway`
- **Identity**: Cognito, imported Cognito, Entra ID
- **Tool mode**: `passthrough`
- **Deploy**: `make example-gateway-lambda-deploy`

| Host-facing tool | What it does |
| --- | --- |
| `getCurrentTime` | Returns the current server time — a zero-arg Lambda tool. |
| `summarizeText` | Trims/echoes text — shows an argument-taking Lambda tool. |

| Stack | Purpose |
| --- | --- |
| `McpSavvyGatewayDemoCognito` | Cognito user pool (or imported via the bring-your-own-pool path). |
| `McpSavvyGatewayDemoGateway` | AgentCore Gateway + the Lambda target hosting both tools. |

Compare with: [`gateway-3lo-mcp`](./examples/gateway-3lo-mcp).

### (C) Gateway + GitHub 3LO MCP — `gateway-3lo-mcp`

✅ validated — full 3LO chain live against GitHub (2026-05-28)

The "list my GitHub repositories" demo — an AgentCore Gateway with a GitHub OpenAPI target and the full third-party OAuth (3LO) consent flow handled transparently by the bridge.

Reach a partner API (GitHub, Slack, …) on the user's behalf. The first tool call returns -32042 UrlElicitationRequired; the bridge opens the consent page, completes session binding via OAuthCompleteSessionApi, and retries — the host just sees a successful result.

- **Shape**: AgentCore Gateway · Direct (no front door)
- **Constructs**: `CognitoAuth`, `AgentCoreGateway`, `OAuthCompleteSessionApi`
- **Identity**: Cognito
- **Tool mode**: `search-local`
- **Deploy**: `make example-gateway-3lo-deploy`

| Host-facing tool | What it does |
| --- | --- |
| `github___getAuthenticatedUser` | Returns the signed-in user's GitHub profile. |
| `github___listUserRepos` | Lists the user's repositories after 3LO consent. |

| Stack | Purpose |
| --- | --- |
| `McpSavvy3loDemoCognito` | Cognito user pool that gates the gateway. |
| `McpSavvy3loDemoGateway` | AgentCore Gateway (GitHub OpenAPI target) + OAuthCompleteSessionApi. |

Compare with: [`gateway-lambda-mcp`](./examples/gateway-lambda-mcp).

### (G) ChatGPT App (banking-grade) — `chatgpt-app-mcp`

✅ validated — live end-to-end (2026-06-11)

Banking-grade ChatGPT App. ChatGPT prompts the user's balance; the model sees a safe summary; the actual number is delivered to a sandboxed widget only, through a WAF-protected Regional REST API → VPC Lambda → DynamoDB.

Sensitive financial data over MCP without leaking the value to the model. The connector returns "Your balance is available in the secure panel."; a widget iframe POSTs a one-time secure_view_ref to a widget-only endpoint and renders the real number locally. The Lambda is VPC-isolated; the Regional REST API custom domain is the only public ingress.

- **Shape**: Lambda MCP · REST API front door
- **Constructs**: `CognitoAuth`
- **Identity**: Cognito
- **Tool mode**: `passthrough`
- **Deploy**: `make example-chatgpt-app-deploy`

| Host-facing tool | What it does |
| --- | --- |
| `get_credit_balance_status` | Returns "available" / "unavailable" + currency. Never the amount or account details. Surfaces a secure_view_ref in `_meta` for the widget. |
| `get_credit_balance_actual` | Widget-only (`_meta.ui.visibility=['app']`). Redeems a single-use secure_view_ref and returns the actual balance via `_meta` — never `structuredContent`/`content`, so the model never sees it. |
| `list_branches` | Public, model-visible. Lists Savvy branches across Israel with today's open/closed status (computed in branch-local time). Optional `city` filter narrows the result; widget renders a card with a directions click-through per row. |
| `find_nearest_branches` | Public, model-visible. Reads the user's coarse location from `_meta["openai/userLocation"]`, ranks open branches by Haversine distance, and returns the top N with Google Maps directions URLs (free, no API key — Maps does its own geolocation on click). Falls back to a city-sorted list when location sharing is off. |

| Stack | Purpose |
| --- | --- |
| `McpSavvyChatGptAppCognito` | Cognito user pool — MFA TOTP required; public PKCE client; Hosted UI for OAuth. |
| `McpSavvyChatGptAppData` | 3 DynamoDB tables (customer_data, secure_view_refs, audit_log) with AWS-managed encryption + PITR + deletion protection. |
| `McpSavvyChatGptAppNetwork` | Private isolated VPC + Logs interface endpoint + DynamoDB gateway endpoint; no NAT or internet gateway. |
| `McpSavvyChatGptAppApp` | VPC Lambda + Regional REST API + Cognito authorizer + request validator + regional WAF + custom domain. |

Compare with: [`gateway-lambda-mcp`](./examples/gateway-lambda-mcp), [`minimal-mcp`](./examples/minimal-mcp).


## Identity providers

The `IdentityProvider` abstraction makes JWT-authorizer wiring
identical across IdPs. Cognito is the zero-config default; any
OIDC-compliant IdP drops in by changing `MCP_SAVVY_OIDC_ISSUER` +
`MCP_SAVVY_CLIENT_ID`.

| IdP | Issuer URL | Notes |
| --- | --- | --- |
| AWS Cognito | `https://cognito-idp.<region>.amazonaws.com/<pool-id>` | Default in every example. Zero IdP config for new users. |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant>/v2.0` | Public client (PKCE, no secret). Needs accessTokenAcceptedVersion=2 and an `azp`-claim authorizer rule — handled by entraExternalOidc(). Full walkthrough in examples/identity-providers/entra.md. |
| Okta | `https://<your-domain>.okta.com/oauth2/default` | Public Native app (PKCE). Custom authorization server (the bundled `default` server) — `aud` is `api://default` and the client id rides in the `cid` claim, not `client_id`/`azp`. Handled by oktaExternalOidc(). |
| Auth0 | `https://<your-domain>.auth0.com/` | Public Native client (PKCE). You MUST pass an API Identifier as the audience or Auth0 returns an opaque token, not a JWT; client id rides in `azp`. Handled by auth0ExternalOidc(). |
| Keycloak | `https://<host>/realms/<realm>` | Public client with PKCE. Client id rides in `azp`; `aud` is not set to the client by default, so audience validation is skipped unless an audience mapper is added. Handled by keycloakExternalOidc(). |

---

See also: [README.md](./README.md) (quickstart) ·
[FEATURES.md](./FEATURES.md) (long-form features) ·
[SECURITY.md](./SECURITY.md) (threat model).
