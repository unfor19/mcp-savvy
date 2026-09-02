# mcp-savvy

<p align="center"><img src="./assets/mcp-savvy/cover.png" alt="One chat client connects through authenticated mcp-savvy access to multiple remote tools" width="720"></p>

[![npm](https://img.shields.io/npm/v/mcp-savvy)](https://www.npmjs.com/package/mcp-savvy)

`mcp-savvy` lets Codex, Claude, Kiro, and Cursor sign in to protected remote tools,
with optional search-and-invoke that avoids loading a large catalog. Run `npx -y mcp-savvy`.

## Why mcp-savvy? ([compare alternatives](./COMPARISON.md))

| Problem | What mcp-savvy provides |
| --- | --- |
| Protected remote MCP | OIDC discovery, browser PKCE, secure storage, and refresh |
| AI app expects a local command | Connects it securely to the remote MCP |
| Tool requires third-party OAuth | AgentCore 3LO completion and automatic retry |
| Large tool catalog | Optional two-tool search-and-call surface |

## What you need

Install [Node.js 20 or newer](https://nodejs.org/en/download), then get these
values from your MCP provider:

| Value | When needed |
| --- | --- |
| Remote MCP URL | Always |
| OIDC issuer URL | Always |
| OAuth public client ID | Always; this is not a secret |
| Complete-session URL | For 3LO tools such as GitHub or Slack |
| Tool mode | Optional; defaults to `passthrough` |

The complete-session URL is not the local callback URL. Deploy it with the
[Gateway 3LO example](./examples/gateway-3lo-mcp/), or get it from your provider.

### Ask an AI agent to set it up

Paste this prompt into any agent that can inspect and edit files on your computer:

```text
Help me configure mcp-savvy on this computer.

First, ask me for:
1. Which client I use: Codex, Claude Code CLI or Desktop Code tab, regular Claude Desktop chat, Kiro, or Cursor.
2. The remote MCP URL.
3. The OIDC issuer URL.
4. The OAuth public client ID.
5. Whether it exposes 3LO tools such as GitHub or Slack. If yes, ask for the provider-supplied complete-session URL. If unsure, do not guess.
6. The recommended tool mode. Use passthrough if I was not given one.

Use current official client documentation and run npx -y mcp-savvy. Inspect the existing MCP configuration first. If mcp-savvy is identical, do nothing; if it differs, show the difference and ask before replacing it. Never add a client secret or OAuth token. Preserve unrelated settings, validate the configuration, and tell me how to verify the connection.
```

The URLs and public client ID are configuration values, not OAuth tokens. Follow your organization's policy if deployment identifiers are private.

## Set up your MCP client

These are separate products and configuration stores. Choose the client where
you want to use the tools, then expand only its instructions.

<details>
<summary><strong>Codex — expand setup</strong></summary>

Codex CLI, the IDE extension, and the ChatGPT desktop app share host configuration.
Run `codex mcp get mcp-savvy` first; if absent, run:

```sh
codex mcp add mcp-savvy \
  --env MCP_SAVVY_REMOTE_URL=https://your-mcp.example.com/mcp \
  --env MCP_SAVVY_OIDC_ISSUER=https://your-issuer.example.com \
  --env MCP_SAVVY_CLIENT_ID=your-public-client-id \
  --env MCP_SAVVY_COMPLETE_SESSION_URL=https://your-mcp.example.com/complete-session \
  --env MCP_SAVVY_TOOL_MODE=passthrough \
  -- npx -y mcp-savvy
```

Verify with `codex mcp list` or `/mcp`, then restart the app or IDE extension.

</details>

<details>
<summary><strong>Claude Code CLI — expand setup</strong></summary>

Run this in a terminal. It creates a user-scoped server available across your
Claude Code projects:

```sh
claude mcp add-json --scope user mcp-savvy '{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "mcp-savvy"],
  "env": {
    "MCP_SAVVY_REMOTE_URL": "https://your-mcp.example.com/mcp",
    "MCP_SAVVY_OIDC_ISSUER": "https://your-issuer.example.com",
    "MCP_SAVVY_CLIENT_ID": "your-public-client-id",
    "MCP_SAVVY_COMPLETE_SESSION_URL": "https://your-mcp.example.com/complete-session",
    "MCP_SAVVY_TOOL_MODE": "passthrough"
  }
}'
```

`add-json` leaves an existing same-scope entry unchanged. Inspect it with
`claude mcp get mcp-savvy`; replace it only intentionally.

Check the connection with `claude mcp list`. Inside Claude Code, run `/mcp` to
see server status and tool count.

</details>

<details>
<summary><strong>Claude Code in the Claude Desktop Code tab — expand setup</strong></summary>

The Code tab runs Claude Code and shares its MCP configuration with the Claude
Code CLI. Use the command above, start a local Code session, and check its MCP
servers from the Code tab's connectors UI or `/mcp`.

This does **not** configure regular chats in Claude Desktop. The Code tab reads
Claude Code settings such as `~/.claude.json`; regular Desktop chat uses its own
local-server configuration.

</details>

<details>
<summary><strong>Regular Claude Desktop chat on macOS — expand setup</strong></summary>

Claude Desktop Extensions are the preferred installation experience, but
mcp-savvy does not currently build or publish a Desktop Extension (`.mcpb`). Use
the raw local-server configuration instead.

Completely quit Claude Desktop with **Cmd+Q**. Open
`~/Library/Application Support/Claude/claude_desktop_config.json` and add:

```json
{
  "mcpServers": {
    "mcp-savvy": {
      "command": "npx",
      "args": ["-y", "mcp-savvy"],
      "env": {
        "MCP_SAVVY_REMOTE_URL": "https://your-mcp.example.com/mcp",
        "MCP_SAVVY_OIDC_ISSUER": "https://your-issuer.example.com",
        "MCP_SAVVY_CLIENT_ID": "your-public-client-id",
        "MCP_SAVVY_COMPLETE_SESSION_URL": "https://your-mcp.example.com/complete-session",
        "MCP_SAVVY_TOOL_MODE": "passthrough"
      }
    }
  }
}
```

If the file already has an `mcpServers` object, add only the `mcp-savvy` entry
inside it. Reopen Claude Desktop. In a regular chat, click the **+** button and
open **Connectors** to confirm the server and its tools are present; connection
status and logs are also available in **Settings > Developer**.

</details>

<details>
<summary><strong>Kiro — expand setup</strong></summary>

Open the user MCP configuration from Kiro's command palette (**Kiro: Open user
MCP config (JSON)**), or edit `~/.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "mcp-savvy": {
      "command": "npx",
      "args": ["-y", "mcp-savvy"],
      "env": {
        "MCP_SAVVY_REMOTE_URL": "https://your-mcp.example.com/mcp",
        "MCP_SAVVY_OIDC_ISSUER": "https://your-issuer.example.com",
        "MCP_SAVVY_CLIENT_ID": "your-public-client-id",
        "MCP_SAVVY_COMPLETE_SESSION_URL": "https://your-mcp.example.com/complete-session",
        "MCP_SAVVY_TOOL_MODE": "passthrough"
      },
      "disabled": false
    }
  }
}
```

Save the file. Kiro hot-reloads changed MCP servers. Confirm `mcp-savvy` appears
in the MCP panel, then approve a tool when Kiro asks. Do not add `autoApprove`
unless you deliberately want Kiro to run named tools without prompting.

</details>

<details>
<summary><strong>Cursor — expand setup</strong></summary>

Completely quit Cursor. Create or edit the global configuration at
`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mcp-savvy": {
      "command": "npx",
      "args": ["-y", "mcp-savvy"],
      "env": {
        "MCP_SAVVY_REMOTE_URL": "https://your-mcp.example.com/mcp",
        "MCP_SAVVY_OIDC_ISSUER": "https://your-issuer.example.com",
        "MCP_SAVVY_CLIENT_ID": "your-public-client-id",
        "MCP_SAVVY_COMPLETE_SESSION_URL": "https://your-mcp.example.com/complete-session",
        "MCP_SAVVY_TOOL_MODE": "passthrough"
      }
    }
  }
}
```

Reopen Cursor. Go to **Customize > MCPs** to confirm the server is connected.
Agent can use enabled MCP tools when relevant and normally asks for approval.

</details>

Official setup references: [Codex MCP](https://developers.openai.com/codex/mcp), [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Claude Code Desktop](https://code.claude.com/docs/en/desktop), and [Claude Desktop local servers](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).
[Kiro MCP configuration](https://kiro.dev/docs/mcp/configuration/) and [Cursor MCP](https://prod.cursor.com/help/customization/mcp) cover the other clients.

## Try it

Ask your client:

> List my public GitHub repositories.

Use a prompt that matches the tools your provider exposes if it does not provide
GitHub tools. On the first authenticated request:

1. The MCP client starts `mcp-savvy`.
2. `mcp-savvy` discovers that authentication is required.
3. Your browser opens the provider's real sign-in page.
4. After authentication, the browser shows the mcp-savvy success page.
5. The token bundle is stored in your operating system credential store.
6. Later requests reuse or refresh the cached authentication without placing a token in the MCP client configuration.

That reusable workflow includes OIDC discovery, browser sign-in, PKCE and local
callback handling, secure credential storage, refresh, and authenticated
forwarding to any compatible remote MCP.

## Authentication and sign-out

Run these with the same environment values as the MCP server entry:

```sh
npx -y mcp-savvy --logout
npx -y mcp-savvy --force-login
```

- `--logout` removes locally cached authentication for the current token
  namespace. It does not necessarily revoke the provider-side token or browser
  session.
- `--force-login` clears that cached authentication and starts a fresh local
  OAuth flow. An existing identity-provider SSO cookie can still sign you in
  without showing the credential form.

mcp-savvy automatically derives a stable token namespace from the OIDC issuer
and client ID. Configurations with the same issuer and client ID normally share
cached authentication. Ordinary users do not need to set a namespace. As an
advanced option, `MCP_SAVVY_TOKEN_NAMESPACE` intentionally isolates credentials,
for example to keep a demo separate from normal use.

## Troubleshooting

- **Browser ends at localhost with `ERR_CONNECTION_REFUSED`:** the one-time
  callback listener is no longer running. Return to the MCP client and retry the
  operation so mcp-savvy starts a fresh listener. Do not publish screenshots
  containing OAuth authorization codes or `state` parameters.
- **Authentication took too long:** the callback listener expires after five
  minutes. Retry from the MCP client and complete the new browser flow.
- **macOS asks for the login keychain password:** macOS may ask permission when
  mcp-savvy reads its credential. The prompt can return if the item is deleted or
  recreated, or its access controls change.
- **`--force-login` skips the credential form:** sign out of the demo identity
  provider or clear cookies for only that provider, then retry. Clearing the
  local mcp-savvy token does not clear the browser's SSO session.
- **`npx` or Node.js is unavailable:** install Node.js 20 or newer, reopen the
  client, and confirm `node --version` and `npx --version` work in a terminal.
- **Claude Desktop tools are missing:** quit with Cmd+Q, reopen it, and validate
  the JSON. Closing only the window does not restart local MCP servers.
- **It works in Claude Code but not Desktop chat:** these are separate stores.
  Add the server to `claude_desktop_config.json` for regular Desktop chat.

## Tool modes and more

`passthrough` is the default. For large catalogs, see [tool flattening](./FEATURES.md#search-first-tool-flattening) and [all environment options](./.env.example).

Backend implementers: [examples](./examples/), [architecture](./ARCHITECTURE.md), and [security](./SECURITY.md).

## Development

```sh
pnpm install --frozen-lockfile
make verify
```

Run `make help` for every repository command.

## License

[MIT](./LICENSE). Not affiliated with or endorsed by AWS, Anthropic, or the Model Context Protocol.
