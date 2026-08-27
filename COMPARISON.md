# How mcp-savvy compares

The short pitch is in the [README](./README.md). This is the long
form: where mcp-savvy sits in the ecosystem, who the real
alternatives are, and the honest scope boundaries.

mcp-savvy is **not** a generic MCP transport tool. It's opinionated
for **AWS-hosted, JWT-authenticated MCP servers**, and it spans two
halves that most alternatives only cover one of:

- **Client side** — a published `npx mcp-savvy` stdio↔Streamable-HTTP
  bridge with auth, token refresh, 3LO consent, and tool-flattening
  baked in. No AWS account needed on the end user's machine.
- **Backend side** — `@mcp-savvy/cdk` constructs that stand up the
  protected backend (Cognito + AgentCore Runtime / Gateway / KB),
  `cdk-nag` clean by default.

"Alternative" means three different things depending on which half
you're comparing, so the landscape splits into three groups.

## 1. Stdio ↔ HTTP bridges (the client half)

The commodity layer. These forward JSON-RPC over stdio to a remote
MCP server. mcp-savvy's edge is the auth + AWS-specific orchestration
layered on top, not the transport itself.

| Tool                                                            | What it is                                             | Gap vs mcp-savvy                                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| [`mcp-remote`](https://github.com/geelen/mcp-remote)            | The de-facto npx stdio↔HTTP bridge with OAuth 2.0      | Generic OAuth only — no AgentCore Gateway 3LO, no search-first flattening, no AgentCore-aware retries, no CDK backend |
| [`supergateway`](https://github.com/supercorp-ai/supergateway)  | stdio↔SSE/HTTP relay                                   | Transport-first, not auth-first; bring your own auth                                                                  |
| [`mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy) (Python) | Bidirectional stdio↔Streamable-HTTP transport switcher | Python only; no first-class OAuth/PKCE/keychain                                                                       |
| [`acehoss/mcp-gateway`](https://github.com/acehoss/mcp-gateway) | Bridges stdio servers to HTTP+SSE/REST, multi-instance | Self-hosted relay; no AWS/IdP integration                                                                             |

`mcp-remote` is the closest client-side comparison. It owns the
transport but stops at generic OAuth — the AgentCore 3LO dance and
search-first tool flattening are where it has nothing.

## 2. AWS-native backend deployment (the infra half)

The real competition for the CDK side. The closest is AWS's own
tooling.

- [**Bedrock AgentCore Starter Toolkit**](https://aws.github.io/bedrock-agentcore-starter-toolkit/user-guide/create/quickstart.html)
  — `agentcore create` generates an agent, MCP integration, and
  optional CDK/Terraform stacks for Runtime, Gateway, and Memory.
  The most direct overlap with mcp-savvy's backend. Difference: it's
  a Python-centric code generator/scaffolder, not a reusable construct
  library paired with an auth-baked client bridge.
- [**Guidance for Deploying MCP Servers on AWS**](https://github.com/aws-solutions-library-samples/guidance-for-deploying-model-context-protocol-servers-on-aws)
  — an AWS Solutions Library reference architecture: containerized MCP
  behind CloudFront + WAF + ALB with an OAuth 2.0 auth service.
  Heavier and ECS/ALB-based rather than AgentCore-native; a reference
  architecture, not a library.
- [**awslabs/amazon-bedrock-agentcore-samples**](https://github.com/awslabs/amazon-bedrock-agentcore-samples)
  — sample notebooks and repos for hosting MCP on AgentCore
  Runtime/Gateway. Examples, not a packaged toolkit.
- [**awslabs nx-plugin-for-aws**](https://awslabs.github.io/nx-plugin-for-aws/en/guides/py-mcp-server)
  — generates a Python MCP server with optional AgentCore deploy.
  A generator, Python, no client bridge.

These own backend scaffolding but none pairs it with a matching
auth-baked client, and the AWS-first options lean Python.

## 3. Managed MCP gateways (the buy-vs-build axis)

For teams that would rather not self-host the control plane at all.
A different category — control-plane-as-a-service vs. a toolkit you
own and deploy into your own account.

- [**Cloudflare remote MCP**](https://blog.cloudflare.com/remote-model-context-protocol-servers-mcp/)
  — `workers-oauth-provider` plus a Workers deployment. The non-AWS
  equivalent: a remote MCP with OAuth login on Cloudflare's edge.
  Different cloud, fully managed runtime.
- **MintMCP / Composio / Portkey / Airia**
  ([gateway roundup](https://composio.dev/blog/best-mcp-gateway-for-developers))
  — managed SaaS MCP gateways with SSO, SCIM/RBAC, tool allowlisting,
  audit logs, and OAuth brokering across stdio and hosted servers.
  They solve enterprise governance, not "ship my own AWS-native
  server." Platform lock-in is the trade.

## Bottom line

No single project covers mcp-savvy's exact span:

- The bridges (`mcp-remote`) own client transport but stop at generic
  OAuth.
- AWS's own toolkit (AgentCore Starter Toolkit) owns backend
  scaffolding but is a Python generator without a matching client.
- The managed gateways (Cloudflare, MintMCP) own governance but lock
  you to their platform.

mcp-savvy's defensible claim is the **vertical seam**: one client
bridge plus one CDK construct library, both opinionated for AWS
AgentCore and any OIDC IdP, with the two genuinely hard,
under-served pieces solved end-to-end —
[**Gateway 3LO orchestration**](./FEATURES.md#agentcore-identity-3lo-orchestration)
and [**search-first tool flattening**](./FEATURES.md#search-first-tool-flattening).
That's where every alternative has a hole.

---

See also: [README.md](./README.md) (quickstart) ·
[ARCHITECTURE.md](./ARCHITECTURE.md) (architecture + example matrix) ·
[FEATURES.md](./FEATURES.md) (long-form features).

> Sources were rephrased for compliance with licensing restrictions.
> Last reviewed 2026-06.
