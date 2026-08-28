# mcp-savvy

[![npm](https://img.shields.io/npm/v/mcp-savvy)](https://www.npmjs.com/package/mcp-savvy)

> The expert MCP deployer, so you only deal with your app.

> **Disclaimer:** `mcp-savvy` is an independent, opinionated open-source
> project. It is not an official AWS, Anthropic, or Model Context
> Protocol resource, and is not affiliated with or endorsed by them.
> Provided as-is under the [MIT license](./LICENSE) — see
> [SECURITY.md](./SECURITY.md) for the threat model and what's out of
> scope.

`mcp-savvy` is a stdio bridge and a repository of CDK building blocks
for shipping **protected MCP servers on AWS**. Drop a one-liner into
your MCP client config and your agent talks to a JWT-authenticated
AgentCore Runtime or Gateway over Streamable HTTP. The npm package
contains the CLI bridge; the CDK constructs currently remain
source workspaces used by this repository's examples.

[![mcp-savvy architecture: MCP clients connect through the local bridge to protected AWS AgentCore runtimes and gateways](./docs/architecture-dark.webp)](./ARCHITECTURE.md)

## What mcp-savvy gives organizations

- **One MCP client entry for any compatible protected remote MCP.** Point
  `npx mcp-savvy` at a Streamable HTTP server and use it from stdio-based
  hosts such as Kiro, Claude Code, or Codex. The package handles browser
  sign-in, token refresh, and secure local token storage.
- **Two tools instead of a huge catalog.** Set `MCP_SAVVY_TOOL_MODE` to
  `search-local` and the host sees only `${prefix}_search` and
  `${prefix}_call`. It finds the relevant upstream tool first, then calls
  it, without loading every tool schema into the model's context.
- **A ready path to protected MCPs on AWS.** The repository's CDK building
  blocks configure JWT-protected AgentCore Runtime and Gateway deployments,
  so each team does not have to rebuild the same auth and infrastructure.
- **Enterprise identity without IdP guesswork.** Use Cognito, import an
  existing Cognito pool, or connect an OIDC provider directly. Presets and
  setup guides cover Microsoft Entra ID, Okta, Auth0, and Keycloak,
  including their different issuer, audience, and client-id claim rules.
- **Native AgentCore Gateway search when quality matters.** Set the same
  two-tool interface to `search-gateway` and searches use AgentCore
  Gateway's managed semantic index; switch back to `search-local` for a
  deterministic local search with no per-query AWS search charge.
- **Third-party OAuth for Gateway tools.** The bridge completes AgentCore
  Identity 3LO flows for targets such as GitHub, then retries the original
  tool call after the user grants access.

In short: configure the MCP once, choose the identity and search mode, and
give users one small `npx` entry instead of custom auth, bridge, and tool
discovery code.

## When to use mcp-savvy

Use it when your MCP server runs on AWS AgentCore behind JWT/OIDC, but
your users need a simple local `npx` entry point with browser sign-in,
secure token storage, Gateway 3LO, or search-first tool flattening. It
bridges MCP's local **stdio** transport to remote **Streamable HTTP** and
pairs that client with reusable CDK constructs for the protected backend
([MCP transport and authorization boundary](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports),
[AgentCore MCP hosting](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html)).

Skip it when your MCP host already handles the remote server's OAuth
flow directly, the server is local or unauthenticated, or the caller is
service-to-service using IAM SigV4 without a human browser login.

See [COMPARISON.md](./COMPARISON.md) for the full alternatives and
buy-vs-build tradeoffs.

## Quickstart

### Connect to an existing protected MCP server

Runs via [`npx`](https://docs.npmjs.com/cli/v10/commands/npx) — no
global install, Node 20+. Drop this into your MCP client config
(`~/.kiro/settings/mcp.json`, Claude Desktop's config, etc.):

```json
{
  "mcpServers": {
    "my-protected-mcp": {
      "command": "npx",
      "args": ["-y", "mcp-savvy"],
      "env": {
        "MCP_SAVVY_REMOTE_URL": "https://....bedrock-agentcore.us-east-1.amazonaws.com/mcp",
        "MCP_SAVVY_OIDC_ISSUER": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_xxx",
        "MCP_SAVVY_CLIENT_ID": "your-app-client-id"
      }
    }
  }
}
```

First run pops a browser tab for sign-in; the token caches in your OS
keychain. Subsequent runs are silent until refresh expires. Every
`MCP_SAVVY_*` var is documented in [`.env.example`](./.env.example).

### Deploy and test the GitHub 3LO demo

Want to try the complete path yourself? This example deploys Cognito,
an AgentCore Gateway with two GitHub tools, and the callback API used
to complete third-party OAuth. It creates AWS resources that can incur
charges. You need Node 20+, `pnpm`, AWS CLI v2, an authenticated AWS
profile, and a GitHub OAuth App that you own.

1. Clone the repository, install the locked dependencies, and verify
   the AWS account and region you intend to use:

   ```sh
   git clone https://github.com/unfor19/mcp-savvy.git
   cd mcp-savvy
   pnpm install --frozen-lockfile

   export AWS_PROFILE=<profile>
   export AWS_REGION=<region>
   aws sts get-caller-identity --profile "$AWS_PROFILE"
   ```

2. In GitHub, open **Settings → Developer settings → OAuth Apps** and
   create an OAuth App. If GitHub requires a callback before the
   AgentCore callback exists, use the app's homepage temporarily; you
   will replace it below. Generate a client secret, then create the
   matching AgentCore credential provider through the interactive AWS
   CLI prompt so the secret never enters shell history:

   ```sh
   aws bedrock-agentcore-control \
     create-oauth2-credential-provider --region "$AWS_REGION" \
     --name <provider-name> --credential-provider-vendor GithubOauth2 \
     --cli-auto-prompt
   ```

   Select `githubOauth2ProviderConfig` and enter the OAuth App client
   ID and secret. Copy the `callbackUrl` from the response, set it as
   the GitHub OAuth App's **Authorization callback URL**, and save the
   app. Then read the provider back and export its ARN:

   ```sh
   aws bedrock-agentcore-control get-oauth2-credential-provider \
     --region "$AWS_REGION" --name <provider-name> \
     --query '{arn:credentialProviderArn,callbackUrl:callbackUrl}'

   export MCP_SAVVY_GITHUB_OAUTH_PROVIDER_ARN=<provider-arn>
   ```

3. Bootstrap CDK once per account and region, inspect the synthesized
   infrastructure and diff, then deploy:

   ```sh
   make example-gateway-3lo-bootstrap
   make example-gateway-3lo-synth
   make example-gateway-3lo-diff
   make example-gateway-3lo-deploy
   ```

4. Create a Cognito test user and run the automated smoke test. Follow
   the emailed temporary-password flow and MFA prompts in the browser
   (check spam or junk if the invitation does not appear):

   ```sh
   make example-gateway-3lo-add-user EMAIL=you@example.com
   make example-gateway-3lo-smoke
   make example-gateway-3lo-config
   ```

   The smoke test proves Cognito login, MCP initialization, and tool
   discovery. The final command prints the four non-secret
   `MCP_SAVVY_*` values needed by your MCP client.

5. Copy those four values into the client configuration from the
   previous section, including `MCP_SAVVY_COMPLETE_SESSION_URL`.
   Restart or reconnect the MCP server, then ask your host to call
   `github___getAuthenticatedUser` and `github___listUserRepos`.
   Approve the MCP tool invocation if your host asks, then approve
   GitHub access when the browser opens. Both calls returning real
   results is the end-to-end acceptance test.

   Some hosts restart their stdio child during the first interactive
   authorization. If the first call ends with `-32042` (more
   information required) or `Connection closed`, finish browser
   consent, reconnect the MCP server, and retry once. Do not add a
   GitHub personal access token; AgentCore 3LO supplies the GitHub
   credential after consent.

6. Try each tool-surface mode by setting `MCP_SAVVY_TOOL_MODE` in the
   same `env` object and reconnecting the server:

   | Value | Expected tools in the host |
   | ----- | -------------------------- |
   | `passthrough` or omitted | the real GitHub tools, plus the gateway search tool |
   | `search-local` | `mcp_savvy_search` and `mcp_savvy_call`; deterministic local filtering |
   | `search-gateway` | `mcp_savvy_search` and `mcp_savvy_call`; managed semantic search |

   In either search-first mode, call `mcp_savvy_search` first, then
   pass the returned `tool_name` and matching arguments to
   `mcp_savvy_call`. The second tool executes the selected operation;
   its public name is `call`, not `execute`.

7. When finished, clear the local token cache and destroy the example
   stacks:

   ```sh
   make example-gateway-3lo-logout
   make example-gateway-3lo-destroy
   ```

   The shared AgentCore credential provider and GitHub OAuth App are
   intentionally retained. Delete either only after confirming it is
   no longer used elsewhere. For the full provider-cleanup command and
   an agent-ready setup prompt, see the
   [`gateway-3lo-mcp` guide](./examples/gateway-3lo-mcp/).

## Tool modes

By default the bridge runs in `passthrough` mode: it forwards the
upstream `tools/list` verbatim, so the host sees every real tool. For
backends with a large tool catalog, set `MCP_SAVVY_TOOL_MODE` to
collapse the surface down to two synthetic tools
(`${prefix}_search` + `${prefix}_call`) that search and invoke the
real tools on demand:

```json
{
  "env": {
    "MCP_SAVVY_REMOTE_URL": "...",
    "MCP_SAVVY_OIDC_ISSUER": "...",
    "MCP_SAVVY_CLIENT_ID": "...",
    "MCP_SAVVY_TOOL_MODE": "search-local"
  }
}
```

| Mode (`MCP_SAVVY_TOOL_MODE`) | Tools host sees               | When to use                                                                                                                                                                           |
| ---------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `passthrough` (default)      | every upstream tool, verbatim | small catalogs (≤10 tools), demos, debugging                                                                                                                                          |
| `search-local`               | 2 synthetic (search + call)   | many tools, cost-sensitive — filters a local cache, $0 search cost                                                                                                                    |
| `search-gateway`             | 2 synthetic (search + call)   | many tools, quality-sensitive — forwards to [AgentCore Gateway semantic search](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-using-mcp-semantic-search.html) |

Full comparison and wire details in [FEATURES.md](./FEATURES.md#search-first-tool-flattening).

## Examples

Each example deploys end-to-end with `make example-<name>-deploy` and
ships a short README inside its folder with the specifics.

| Example                                                | What it shows                                                                                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| [`minimal-mcp`](./examples/minimal-mcp/)               | Smallest possible protected MCP — Cognito + AgentCore Runtime + one echo tool. Validates the client without any extra moving parts. |
| [`gateway-lambda-mcp`](./examples/gateway-lambda-mcp/) | Expose existing Lambda functions as MCP tools through an AgentCore Gateway. No agent layer.                                         |
| [`gateway-3lo-mcp`](./examples/gateway-3lo-mcp/)       | The "list my GitHub repos" demo — Gateway with a GitHub OpenAPI target and full third-party OAuth (3LO).                            |
| [`kb-mcp`](./examples/kb-mcp/)                         | Strands agent on AgentCore Runtime grounded on a Bedrock Knowledge Base.                                                            |
| [`gateway-kb-mcp`](./examples/gateway-kb-mcp/)         | The same KB fronted by a Gateway Lambda target — no agent.                                                                          |
| [`chatgpt-app-mcp`](./examples/chatgpt-app-mcp/)       | ChatGPT App security demo — model-visible fields carry a safe summary; compatible hosts isolate the actual amount in tool-result `_meta`. |
| [`identity-providers`](./examples/identity-providers/) | Docs-only. Per-IdP setup notes: Entra, Okta, Auth0, Keycloak.                                                                       |

`make help` lists every target.

## Documentation

| Doc                                  | What's in it                                                |
| ------------------------------------ | ----------------------------------------------------------- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | What we build, how the pieces fit, the example matrix       |
| [COMPARISON.md](./COMPARISON.md)     | Alternatives: bridges, AWS-native tooling, managed gateways |
| [FEATURES.md](./FEATURES.md)         | Long-form features: tool modes, 3LO, CDK constructs, IdPs   |
| [SECURITY.md](./SECURITY.md)         | Threat model and what's in/out of scope                     |
| [`.env.example`](./.env.example)     | Every `MCP_SAVVY_*` env var with inline docs                |

New here? Start with [ARCHITECTURE.md](./ARCHITECTURE.md) for the
*what* and *why*, then pick the example closest to what you want to
build.

## Development

`pnpm` monorepo, audited by [fon](https://fon.ginylil.com/).

```sh
make help            # list targets
make verify          # full pre-commit gate (build + typecheck + test + fon + doc drift)
make architecture    # regenerate ARCHITECTURE.md from examples/*/example.yaml
```

Operating rules for agents in [AGENTS.md](./AGENTS.md).

## License

[MIT](./LICENSE).
