# mcp-savvy

[![npm](https://img.shields.io/npm/v/mcp-savvy)](https://www.npmjs.com/package/mcp-savvy)

> The expert MCP deployer, so you only deal with your app.

**Disclaimer:** `mcp-savvy` is an independent, opinionated open-source
project. It is not an official AWS, Anthropic, or Model Context
Protocol resource, and is not affiliated with or endorsed by them.
Provided as-is under the MIT license.

`mcp-savvy` is a stdio bridge for **protected MCP servers on AWS**.
Drop a one-liner into your MCP client config and your agent talks to
a JWT-authenticated AgentCore Runtime or Gateway over Streamable
HTTP.

This package is the CLI bridge. The full project — CDK constructs
for standing up the backend, deployable examples, and architecture
docs — lives at
[github.com/unfor19/mcp-savvy](https://github.com/unfor19/mcp-savvy).

## Quickstart

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
`MCP_SAVVY_*` var is documented in
[`.env.example`](https://github.com/unfor19/mcp-savvy/blob/main/.env.example).

## Tool modes

By default the bridge runs in `passthrough` mode: it forwards the
upstream `tools/list` verbatim, so the host sees every real tool. For
backends with a large tool catalog, set `MCP_SAVVY_TOOL_MODE` to
collapse the surface down to two synthetic tools
(`${prefix}_search` + `${prefix}_call`) that search and invoke the
real tools on demand.

| Mode (`MCP_SAVVY_TOOL_MODE`) | Tools host sees               | When to use                                                                                                                                                                           |
| ---------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `passthrough` (default)      | every upstream tool, verbatim | small catalogs (≤10 tools), demos, debugging                                                                                                                                          |
| `search-local`               | 2 synthetic (search + call)   | many tools, cost-sensitive — filters a local cache, $0 search cost                                                                                                                    |
| `search-gateway`             | 2 synthetic (search + call)   | many tools, quality-sensitive — forwards to [AgentCore Gateway semantic search](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-using-mcp-semantic-search.html) |

Full comparison and wire details in
[FEATURES.md](https://github.com/unfor19/mcp-savvy/blob/main/FEATURES.md#search-first-tool-flattening).

## CLI flags

- `--login` — force fresh PKCE sign-in
- `--force-login` — unconditional PKCE, clears cached tokens first
- `--logout` — clear cached tokens
- `--print-env` — print resolved config (secrets redacted)

## Documentation

| Doc                                                                               | What's in it                                              |
| --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [ARCHITECTURE.md](https://github.com/unfor19/mcp-savvy/blob/main/ARCHITECTURE.md) | What we build, how the pieces fit, the example matrix     |
| [FEATURES.md](https://github.com/unfor19/mcp-savvy/blob/main/FEATURES.md)         | Long-form features: tool modes, 3LO, CDK constructs, IdPs |
| [SECURITY.md](https://github.com/unfor19/mcp-savvy/blob/main/SECURITY.md)         | Threat model and what's in/out of scope                   |
| [`.env.example`](https://github.com/unfor19/mcp-savvy/blob/main/.env.example)     | Every `MCP_SAVVY_*` env var with inline docs              |

## License

MIT. See
[LICENSE](https://github.com/unfor19/mcp-savvy/blob/main/LICENSE).
