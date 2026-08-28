# mcp-savvy

[![npm](https://img.shields.io/npm/v/mcp-savvy)](https://www.npmjs.com/package/mcp-savvy)

Connect stdio-based MCP clients to a protected AWS AgentCore Runtime or Gateway
with one `npx` command. `mcp-savvy` handles browser sign-in, secure token
storage, and large tool catalogs.

## Why mcp-savvy?

- **No AWS credentials on user machines.** Users sign in with OIDC/PKCE and
  tokens are stored in the operating system keychain.
- **Two tools instead of hundreds.** Hide a large catalog behind `search` and
  `call` without putting every tool schema in the model's context.
- **Your identity provider.** Use Cognito, Entra ID, Okta, Auth0, Keycloak, or
  another compatible OIDC provider.
- **Native AgentCore support.** Connect to Runtime or Gateway, use Gateway
  semantic search, and complete third-party OAuth for tools such as GitHub.

## Quick start

Requires Node.js 20+. Add this server to your MCP client configuration:

```json
{
  "mcpServers": {
    "company-tools": {
      "command": "npx",
      "args": ["-y", "mcp-savvy"],
      "env": {
        "MCP_SAVVY_REMOTE_URL": "https://your-agentcore-endpoint.example/mcp",
        "MCP_SAVVY_OIDC_ISSUER": "https://your-issuer.example",
        "MCP_SAVVY_CLIENT_ID": "your-public-client-id",
        "MCP_SAVVY_TOOL_MODE": "search-local"
      }
    }
  }
}
```

The first connection opens the browser for sign-in. Later connections reuse and
refresh the token from the OS keychain.

All configuration options are documented in [`.env.example`](./.env.example).

## Choose the tool surface

| Mode | What the MCP client sees | Best for |
| --- | --- | --- |
| `passthrough` | Every upstream tool | Small catalogs and debugging |
| `search-local` | `*_search` + `*_call` | Large catalogs, deterministic local search, no per-query AWS search charge |
| `search-gateway` | `*_search` + `*_call` | Large catalogs using AgentCore Gateway semantic search |

See [Search-first tool flattening](./FEATURES.md#search-first-tool-flattening)
for the wire contract and configuration details.

## Deploy the protected backend

This repository also contains reusable CDK source and runnable AWS examples:

- [Minimal Runtime](./examples/minimal-mcp/) — Cognito, AgentCore Runtime, and
  one protected MCP tool.
- [Gateway for Lambda tools](./examples/gateway-lambda-mcp/) — expose existing
  Lambda functions through AgentCore Gateway.
- [Gateway with GitHub OAuth](./examples/gateway-3lo-mcp/) — the complete
  AgentCore third-party OAuth flow.
- [Identity providers](./examples/identity-providers/) — Cognito, Entra ID,
  Okta, Auth0, Keycloak, and generic OIDC setup.

The npm package currently ships the CLI bridge. The CDK constructs remain source
workspaces used by these examples.

## Documentation

- [Features](./FEATURES.md) — authentication, token storage, tool modes, 3LO,
  and CDK constructs.
- [Architecture](./ARCHITECTURE.md) — deployment shapes and the complete example
  catalog.
- [Comparison](./COMPARISON.md) — when to use mcp-savvy instead of another
  bridge or gateway.
- [Security](./SECURITY.md) — threat model and security boundaries.

## Development

```sh
pnpm install --frozen-lockfile
make verify
```

Run `make help` for every repository command.

## License

[MIT](./LICENSE). `mcp-savvy` is an independent open-source project and is not
affiliated with or endorsed by AWS, Anthropic, or the Model Context Protocol.
