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
        "MCP_SAVVY_CLIENT_ID": "your-app-client-id",
        "MCP_SAVVY_COMPLETE_SESSION_URL": "https://your-api.example.com/complete-session"
      }
    }
  }
}
```

`MCP_SAVVY_COMPLETE_SESSION_URL` is required only when AgentCore can request
interactive resource authorization, including Gateway OAuth targets and Runtime
flows such as AWS for SAP `USER_FEDERATION`. It enables the second loopback
listener, authenticated session completion, and one automatic retry. Omit it
for backends that never return such challenges.

First run opens a browser tab for sign-in and persists the token bundle in the
OS keychain or encrypted-file fallback. Independent later processes with the
same effective cache identity reuse or refresh it—even after the writer exits—
while retaining separate stdio and remote MCP transports. No daemon is required.
Every `MCP_SAVVY_*` variable is documented in
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

- `--login` — sign in only when cached credentials cannot be reused or refreshed
- `--force-login` — unconditional PKCE, clears cached tokens first
- `--logout` — clear cached tokens and fail if any populated backend cannot be cleared
- `--print-env` — print resolved, secret-safe cache identity and backend config
  without reading credentials or launching authentication

## Authentication reuse and troubleshooting

The effective cache identity combines the resolved namespace, resolved absolute
data directory, and OS-user context. The default namespace derives from issuer
and client ID. A nonblank `MCP_SAVVY_TOKEN_NAMESPACE` override is authoritative:
issuer/client-ID changes appear in component fingerprints but do not change the
effective identity while the override, data directory, and OS user remain equal.
Whitespace-only overrides use the derived namespace. Namespace,
data-directory, or OS-user drift isolates credentials and can explain repeated
sign-in.

Under the per-namespace cross-process lock, mcp-savvy re-reads storage, reuses a
credential only if its recorded expiry is more than 60 seconds away, attempts
refresh otherwise, then starts browser PKCE if refresh is unavailable or fails.
It persists a replacement before releasing the lock. Startup performs no token
introspection or remote MCP probe.

Keychain reads fall back to the encrypted file only for documented missing,
locally undecodable, or structurally invalid entries. Permission,
integrity/tampering, command-invocation, and unexpected operational errors fail
closed without consulting the file. A successful keychain write removes the
superseded file only afterward; a failed keychain write preserves the file
fallback.

Use the same environment as the MCP entry:

```sh
MCP_SAVVY_DEBUG=1 MCP_SAVVY_LOG=json npx -y mcp-savvy
npx -y mcp-savvy --print-env
```

Debug decisions go to stderr. `--print-env` reports the resolved namespace/data
directory, effective and issuer/client-ID/namespace/data-directory fingerprints,
and available/preferred backends. Diagnostics include stable reasons and
fingerprints but never tokens, complete client IDs, authorization URLs/codes,
PKCE values, OAuth state, or callback correlation values.

A remote 401 gets one forced-refresh/reconnect attempt by default. If the new
transport also receives 401, the current process fails without another token
request or browser sign-in; other processes retain their independent transports.

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
