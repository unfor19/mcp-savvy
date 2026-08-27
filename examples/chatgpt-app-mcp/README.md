# `chatgpt-app-mcp` ✅ validated

Banking-grade ChatGPT App example. End-to-end: a user types *"What is
my current balance?"* into ChatGPT; the connector returns *"Your
credit balance is available in the secure panel."*; a sandboxed
widget renders the actual amount (e.g. `$12,340.55`). The server keeps
the number out of model-visible fields; privacy also depends on the
host honoring MCP Apps app-only visibility and `_meta` isolation.

Cross-host: the widget uses the [MCP Apps standard bridge](https://modelcontextprotocol.github.io/ext-apps/api/)
(spec 2026-01-26) so it renders the same in **Claude, ChatGPT, VS
Code, Goose, Postman, MCPJam**.

## Architecture

```
ChatGPT → Regional REST API custom domain (WAF + Cognito authorizer)
        → Lambda (private isolated VPC; no NAT or internet gateway)
        → DynamoDB (AWS-managed encryption + PITR + deletion protection)
```

Four stacks (CDK):

| Stack                       | Purpose                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `McpSavvyChatGptAppCognito` | User pool with MFA TOTP required + public PKCE client + custom `balance.read` scope.     |
| `McpSavvyChatGptAppData`    | Four DynamoDB tables (`customer_data`, `secure_view_refs`, `audit_log`, `branches`) + seed Lambda. |
| `McpSavvyChatGptAppNetwork` | Private isolated VPC + Logs interface endpoint + DynamoDB gateway endpoint.             |
| `McpSavvyChatGptAppApp`     | VPC Lambda + Regional REST API + Cognito authorizer + validator + WAF + custom domain.  |

Two tools — one model-visible, one widget-only:

| Tool                        | Visibility                                | Returns                                                                        |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| `get_credit_balance_status` | model + app                               | `{ status: "available" \| "unavailable", currency }` + `_meta.secure_view_ref` |
| `get_credit_balance_actual` | app only (`_meta.ui.visibility: ["app"]`) | actual amount in `_meta`; `structuredContent` is just `{ ok: true }`           |

The server-side privacy design keeps the amount out of model-visible fields:
- `get_credit_balance_status`'s `structuredContent` carries only status + currency.
- `get_credit_balance_actual` is hidden from the model (visibility: `["app"]`); the widget invokes it via `window.openai.callTool` (ChatGPT) or `tools/call` postMessage (any MCP Apps client).
- The actual balance lands in `_meta`, which compatible hosts deliver only to the iframe.

The repository cannot enforce the host's model/widget separation. Use
this pattern only with a host that documents app-only tool visibility
and keeps tool-result `_meta` outside model context.

## Quickstart — connecting from ChatGPT

### 1. Set up the environment (one-time)

You need an AWS account, a Route 53 public hosted zone, and a
matching ACM cert in `us-east-1`. Copy `.env.example` to `.env` at
the repo root and fill in:

```sh
MCP_SAVVY_CHATGPT_APP_DOMAIN=chatgpt-app-mcp.example.com
MCP_SAVVY_CHATGPT_APP_CERT_ARN=arn:aws:acm:us-east-1:000000000000:certificate/...
MCP_SAVVY_CHATGPT_APP_HOSTED_ZONE_ID=Z000000000000
MCP_SAVVY_CHATGPT_APP_HOSTED_ZONE_NAME=example.com
```

A wildcard cert covering the FQDN works.

### 2. Deploy

```sh
make example-chatgpt-app-deploy
```

First deploy normally takes several minutes while CloudFormation creates the stacks.
Subsequent deploys: under 30s for app-only changes.

### 3. Provision a test user

```sh
make example-chatgpt-app-add-user EMAIL=you@example.com
```

Cognito emails a temporary password. The user pool requires MFA
TOTP enrollment on first sign-in.

### 4. Seed-fixture mapping (optional)

The seed Lambda preloads five synthetic customer rows. Customer
data is keyed by Cognito's JWT `sub` claim. To map your real signed-
in user to a fixture, update `seed/customer-fixtures.json` and
re-deploy. By default the demo answers "no balance on file" for any
unmapped subject.

### 5. Get the connector config

```sh
make example-chatgpt-app-config
```

Prints something like:

```
  Public URL       https://chatgpt-app-mcp.example.com
  MCP endpoint     https://chatgpt-app-mcp.example.com/mcp   <-- paste into ChatGPT

  Cognito issuer:   https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXXXXXXX
  Cognito client:   xxxxxxxxxxxxxxxxxxxxxxxxxx
  Required scope:   mcp-savvy.chatgpt-app/balance.read
```

### 6. Create the connector in ChatGPT

In ChatGPT: **Settings → Apps & Connectors → Advanced → Developer mode → Create**.

| Field              | Value                                  |
| ------------------ | -------------------------------------- |
| **Name**           | anything (e.g. *Bank balance*)         |
| **Connection**     | **Server URL**                         |
| **Server URL**     | `https://<your-custom-domain>/mcp`     |
| **Authentication** | **OAuth**                              |

Click **Advanced OAuth settings**:

| Field                          | Value                                                        |
| ------------------------------ | ------------------------------------------------------------ |
| **Registration method**        | **User-Defined OAuth Client**                                |
| **OAuth Client ID**            | the Cognito client ID from `make example-chatgpt-app-config` |
| **OAuth Client Secret**        | leave empty (PKCE-only public client)                        |
| **Token endpoint auth method** | **none**                                                     |

ChatGPT auto-discovers everything else from `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`.

### 7. Register ChatGPT's callback URL with Cognito

ChatGPT shows a **Callback URL** in the dialog — looks like
`https://chatgpt.com/connector/oauth/<random-id>`. **Before** you
click *Create*, copy that URL and run:

```sh
make example-chatgpt-app-add-callback CALLBACK=https://chatgpt.com/connector/oauth/<random-id>
```

This appends the callback to the Cognito client's allow-list. If
you skip this step, OAuth fails with `redirect_mismatch` after sign-
in.

### 8. Connect

Tick *"I understand and want to continue"* and click **Create**.
ChatGPT redirects you to the Cognito Hosted UI:

1. Sign in with the email + temporary password.
2. Cognito prompts for a permanent password.
3. Cognito prompts for TOTP enrollment (use Google Authenticator,
   1Password, etc.). Scan the QR code, enter the 6-digit code.
4. Cognito redirects back to ChatGPT. Connector active.

### 9. Try it

In a new ChatGPT chat with the connector enabled:

> *What is my current balance?*

Expected:
- ChatGPT calls `get_credit_balance_status`.
- The widget renders inline with a "Verifying secure session…" skeleton, then resolves to the formatted amount + masked card last-four + "as of" timestamp.
- ChatGPT's text reply says *"Your credit balance is available in the secure panel"* — never the number.
- Behind the scenes: the widget calls `get_credit_balance_actual` via the MCP Apps bridge; the Lambda redeems the 60-second single-use ref, looks up the row, returns the balance in `_meta`. Two audit events fire (`balance_widget_read_requested`, `balance_widget_read_completed`) into the `audit_log` table.

## Commands cheat sheet

| Command                                              | Purpose                                                                                                                                             |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make example-chatgpt-app-synth`                     | Synth all four stacks; cdk-nag clean check.                                                                                                         |
| `make example-chatgpt-app-diff`                      | Show pending changes vs deployed.                                                                                                                   |
| `make example-chatgpt-app-deploy`                    | Deploy all four stacks.                                                                                                                             |
| `make example-chatgpt-app-config`                    | Print the public URL + Cognito issuer/client/scope + table names.                                                                                   |
| `make example-chatgpt-app-add-user EMAIL=...`        | Create a Cognito user.                                                                                                                              |
| `make example-chatgpt-app-add-callback CALLBACK=...` | Add a redirect URI to the Cognito client.                                                                                                           |
| `make example-chatgpt-app-destroy`                   | Tear it all down. Tables have `deletionProtection: true` so you'll need to disable that first via `aws dynamodb update-table` — intentional safety. |

## Cost honesty

**Idle is roughly $20/month in us-east-1 before request usage.** This
is a non-zero-idle example because the private Logs endpoint and WAF
have hourly/base charges:

| Item                                     | ~$/month    |
| ---------------------------------------- | ----------- |
| Logs interface VPCE × 2 AZs              | ~$14        |
| WAF WebACL                               | $5          |
| Route 53 hosted zone (existing)          | $0.50       |
| DynamoDB GW endpoint                     | $0          |
| API Gateway / Cognito / Lambda / DynamoDB | pay-per-use |

Set `MCP_SAVVY_CHATGPT_APP_AZ_COUNT=1` to drop the interface-endpoint
cost roughly in half; this also removes multi-AZ redundancy.

## Reference docs

- [**SECURITY.md**](./SECURITY.md) — what's enabled in MVP, what's available as opt-in hardening (mTLS, CMK, Cognito ASF, CloudTrail data events, VPCE policies, …), and what's out of scope for an OSS demo.
