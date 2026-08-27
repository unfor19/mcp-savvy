# Features

The README has the elevator pitch. This is the long form.

## Stdio ↔ Streamable HTTP bridge

Built on the official
[`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
transports. The bridge speaks JSON-RPC over stdio to your MCP host
(Kiro, Claude Code, Codex, anything that follows the spec) and
Streamable HTTP to your remote backend.

A 401 from the remote drops the cached token, refreshes via the
OIDC provider, and reconnects up to `maxReauthAttempts` times before
failing the host transport. No manual reconnect, no host-side
retry logic.

## OIDC + PKCE sign-in

Authenticates via [PKCE](https://datatracker.ietf.org/doc/html/rfc7636)
in your default browser. Works with any OIDC-compliant IdP:

| IdP                | Issuer URL                                             |
| ------------------ | ------------------------------------------------------ |
| AWS Cognito        | `https://cognito-idp.<region>.amazonaws.com/<pool-id>` |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant>/v2.0`      |
| Okta               | `https://<your-domain>.okta.com`                       |
| Auth0              | `https://<your-domain>.auth0.com/`                     |
| Keycloak           | `https://<host>/realms/<realm>`                        |

The `cognito` preset just composes the issuer URL from a region +
user-pool ID. Set `MCP_SAVVY_PROVIDER=oidc` for anything else.

Each IdP's quirks (issuer shape, and which claim carries the client
id — `azp` for Entra/Auth0/Keycloak, `cid` for Okta) are encoded in a
CDK preset: `entraExternalOidc()`, `oktaExternalOidc()`,
`auth0ExternalOidc()`, `keycloakExternalOidc()`. See
[examples/identity-providers/README.md](./examples/identity-providers/README.md).

## AgentCore Identity 3LO orchestration

[AgentCore Identity](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity.html)
is the AWS service that issues authorization URLs, holds OAuth
credential providers, and exchanges third-party tokens via
[`CompleteResourceTokenAuth`](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/oauth2-authorization-url-session-binding.html).
AgentCore Gateway uses it under the hood for any 3LO target
(GitHub, Slack, etc.) — the gateway returns a `-32042
UrlElicitationRequired` JSON-RPC error carrying the AgentCore-issued
authorization URL, and expects the caller to drive the consent flow
to completion before retrying.

The bridge handles all four steps:

1. Catches `-32042 UrlElicitationRequired` from the gateway and
   opens the AgentCore authorization URL in the default browser.
2. Spawns a second loopback listener on port 33424 to catch
   `session_id` when AgentCore Identity redirects back from the
   third-party IdP.
3. POSTs `{ sessionUri, userToken }` to the deployed
   `OAuthCompleteSessionApi` (an `@mcp-savvy/cdk` construct), which
   calls `CompleteResourceTokenAuth` server-side. AgentCore extracts
   the `sub` claim from `userToken` to bind the OAuth flow to the
   user.
4. Retries the original tool call. The freshly-bound third-party
   token is now in the gateway's vault, so the OpenAPI / Smithy
   target can call the partner API on the user's behalf.

Your host sees a normal successful response. The OAuth dance happens
transparently between the two attempts. Live-validated against
GitHub end-to-end.

## Search-first tool flattening

Three modes set by `MCP_SAVVY_TOOL_MODE`:

| Mode             | Tools host sees                   | When to use                                                                     |
| ---------------- | --------------------------------- | ------------------------------------------------------------------------------- |
| `passthrough`    | every upstream tool, verbatim     | small catalogs (≤10 tools), demos, debugging                                    |
| `search-local`   | 2 synthetic (`*_search`/`*_call`) | many tools, cost-sensitive — bridge filters its cached snapshot, $0 search cost |
| `search-gateway` | 2 synthetic (`*_search`/`*_call`) | many tools, quality-sensitive — search forwards to gateway semantic index       |

`MCP_SAVVY_TOOL_PREFIX` lets you whitelabel: ship `acme_search` +
`acme_call` instead of `mcp_savvy_search` + `mcp_savvy_call`.

The environment-variable contract is documented in [`.env.example`](./.env.example).

### `passthrough` — verbatim forwarding

The default. The bridge forwards `tools/list` and `tools/call`
unchanged. Your host sees every tool the upstream exposes —
including the gateway's built-in
`x_amz_bedrock_agentcore_search` if the gateway was created with
`searchType: SEMANTIC`. The search tool is just another tool the
model can call, billed only when picked.

Best for small tool sets and demos where seeing every tool name
in the host UI is the point. Becomes painful at scale: a gateway
with 200 tools dumps 200 schemas into every model context.

### `search-local` — LLM-driven, deterministic filter

The bridge calls `tools/list` against the upstream once at startup,
caches the schemas locally, and exposes exactly two synthetic tools
to the host: `${prefix}_search` and `${prefix}_call`. Once the cache
is warm, host `tools/list` calls are answered locally — no upstream
round-trip until the bridge restarts.

`${prefix}_search` takes two **optional** arguments:

- `provider`: a typed JSON-Schema `enum` populated from the
  discovered providers (substring before `___` in the upstream tool
  names — `github___listUserRepos` → `github`, `slack___postMessage`
  → `slack`). The host LLM picks from a typed menu.
- `query`: free-text. Tokenized on whitespace; each tool's
  `name + description` is tokenized on whitespace + camelCase
  boundaries + `_-.` so `repos` matches `listUserRepos`. Each query
  token scores 1 point if it appears as a case-insensitive substring
  of any haystack token. Tools sort by score descending.

Both empty returns the full cached list. Either alone narrows along
that axis; together they AND. The host LLM brings the semantics;
the bridge runs a deterministic filter — no embedding model, no AWS
billing per query.

Each ranked tool in the response carries `_score` (number of query
tokens matched); the response envelope carries `_query_tokens`
(total query tokens — the denominator). The LLM reads e.g.
`_score: 3 / _query_tokens: 4` as "matched 3 of 4 search words" and
decides whether to trust the top hit or look further.

Tiered fallback so the LLM never sees a bare empty list:

1. Hits → ranked hits.
2. No hits in scope → all tools in scope, plus a
   `note: "query matched nothing; showing all tools for '<provider>'.
   Try a more specific query."`
3. No `provider`, no hits → full cached list, plus an analogous
   note suggesting a `provider`.
4. Unknown `provider` (typo) → empty list + note listing the known
   providers.

Best for many tools where you want zero per-query cost and don't
need a managed embedding index. Quality is bounded by the host
LLM's ability to pick the right `provider` enum value or query
terms — which, in practice, is high.

### `search-gateway` — gateway semantic index

Same two-tool surface to the host as `search-local`, but
`${prefix}_search` forwards the query to the gateway's
`x_amz_bedrock_agentcore_search` instead of matching locally. The
gateway returns matching tools with full schemas inline.

Requires the gateway to be created with `searchType: SEMANTIC` —
**immutable** post-creation, so it's a deploy-time choice. See the
[AgentCore Gateway semantic search docs](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-using-mcp-semantic-search.html)
for how the managed index works. Costs
[$25 per 1M queries plus $0.02 per 100 tools indexed](https://aws.amazon.com/bedrock/agentcore/pricing/)
(commercial regions, 2026-05). For dev usage on a small gateway,
cents per month; for 200 tools and 50M queries/month, around
$1,250 in search costs alone.

Best for many tools where matching quality matters more than
per-query cost — the gateway runs a managed semantic index, not a
keyword filter.

## OS-keychain token storage

Native keychain via:

- **macOS** — `security` (Keychain Access)
- **Windows** — `cmdkey` + PowerShell against Credential Manager
- **Linux** — `secret-tool` (libsecret)

We **shell out** to these binaries rather than using a native Node
module. No `node-gyp`, no `keytar`, no install-time pain. When the
keychain is unavailable, AES-256-CBC encrypted-file fallback with
a key derived from machine-bound material via `scrypt`.

The token namespace defaults to a slug of the issuer host plus the
first 8 chars of `sha256(clientId)`, so two protected MCPs on the
same machine never share a keychain entry.

See [SECURITY.md](./SECURITY.md) for threat model details.

## Hardened local callback server

- Binds to `127.0.0.1` only, never `0.0.0.0`
- CSRF-protected via `crypto.timingSafeEqual` over equal-length
  state buffers
- HTML-escapes every IdP-supplied value before rendering
- Self-closes after one valid callback or a hard timeout
- Every response carries `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`

Branded success/error pages with glassmorphism design. Brand label
configurable via `MCP_SAVVY_BRAND_NAME`. Same UX for first-leg
sign-in and second-leg 3LO loopback.

## CDK constructs

`@mcp-savvy/cdk` ships:

| Construct                 | What it gives you                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `IdentityProvider`        | Tagged-union abstraction (`Cognito` vs `ExternalOidc`)                                                            |
| `CognitoAuth`             | Cognito user pool with MFA, managed login UI, branding, callback URLs                                             |
| `AgentCoreRuntime`        | AgentCore runtime with JWT authorizer wired to your `IdentityProvider`                                            |
| `AgentCoreGateway`        | AgentCore gateway with the same identity wiring                                                                   |
| `BedrockKnowledgeBase`    | Bedrock Knowledge Base over S3 Vectors (S3 source + Titan v2 + IAM); opt-in deploy-time corpus upload + ingestion |
| `OAuthCompleteSessionApi` | REST API + Lambda for AgentCore Gateway 3LO completion                                                            |
| `importCognito()`         | Bring-your-own-pool path for orgs with shared corporate user pools                                                |
| `externalOidc()`          | Point at any OIDC issuer; set the client-id claim via `customClaim`                                               |
| `entraExternalOidc()`     | Entra v2 preset (v2 issuer, `azp` claim)                                                                          |
| `oktaExternalOidc()`      | Okta preset (custom-auth-server issuer, `cid` claim, `api://default`)                                             |
| `auth0ExternalOidc()`     | Auth0 preset (`azp` claim, required API-identifier audience)                                                      |
| `keycloakExternalOidc()`  | Keycloak preset (`/realms/<realm>` issuer, `azp` claim)                                                           |

The presets exist because access tokens don't agree on where the
authorizing client id lives — Cognito uses `client_id`, Entra/Auth0/
Keycloak use `azp`, Okta uses `cid`. Each preset binds the right claim
and issuer shape so a swap stays one line. Full per-IdP setup in
[examples/identity-providers/README.md](./examples/identity-providers/README.md).

Every construct is `cdk-nag` clean against the
[`AwsSolutions` rule pack](https://github.com/cdklabs/cdk-nag/blob/main/RULES.md#awssolutions)
on `cdk synth --strict`. Where the AWS L2 lags the AgentCore
service (e.g. `OAuthCredentialProviderConfiguration.grantType`),
we drop down via `addPropertyOverride` with a comment citing the
AWS docs and folding the workaround back when the L2 catches up.

## Library use

For integrators who want the parts directly. Every building block
is re-exported from the top-level `mcp-savvy` package:

```ts
import {
  CognitoProvider,
  resolveTokenStore,
  CallbackServer,
  StdioBridge,
  TokenManager,
} from 'mcp-savvy';

const auth = new CognitoProvider({
  region: 'us-east-1',
  userPoolId: 'us-east-1_xxx',
  clientId: process.env.OIDC_CLIENT_ID!,
  redirectUri: 'http://localhost:33423/callback',
});

const store = resolveTokenStore({ namespace: 'my-mcp' });

const tokens = new TokenManager({
  auth,
  store,
  createCallbackServer: () => new CallbackServer(),
  openBrowser: (url) => /* your browser launcher */ undefined,
});

const bridge = new StdioBridge({
  remoteUrl: process.env.REMOTE_URL!,
  getAccessToken: (input) => tokens.getAccessToken(input),
});

await bridge.run();
```

Sub-packages (`@mcp-savvy/auth`, `@mcp-savvy/storage`,
`@mcp-savvy/server`, `@mcp-savvy/bridge`, `@mcp-savvy/core`) are
also published individually for tree-shaking-friendly use.

## Architecture

The client-side data flow (bridge ↔ auth ↔ token store ↔ callback
servers ↔ your AgentCore backend) and the full example matrix live in
the generated [ARCHITECTURE.md](./ARCHITECTURE.md) — the single page
to hand someone for the *what* and the *why*.
