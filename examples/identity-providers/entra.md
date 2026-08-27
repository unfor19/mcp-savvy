# Microsoft Entra ID setup for `mcp-savvy`

This guide walks you through registering a Microsoft Entra ID
application that `mcp-savvy` can authenticate against using PKCE
(no client secret), and pointing the `examples/minimal-mcp` parallel
deploy at it.

The `mcp-savvy` client and the `examples/minimal-mcp` runtime are
both IdP-agnostic — Cognito is the bundled default to keep first-run
friction low, but any standards-compliant OIDC IdP works the same
way. Entra ID just has a few quirks worth documenting.

---

## 1. Create the app registration

1. Azure Portal → **Microsoft Entra ID** → **App registrations** →
   **New registration**

   | Field                   | Value                             |
   | ----------------------- | --------------------------------- |
   | Name                    | `mcp-savvy`                       |
   | Supported account types | Single tenant (or as appropriate) |
   | Redirect URI            | (skip — set in next step)         |

2. Click **Register**. From the Overview page note:
   - **Application (client) ID** → use as `ENTRA_CLIENT_ID`
   - **Directory (tenant) ID** → use as `ENTRA_TENANT_ID`

## 2. Configure as a public client (PKCE, no secret)

`mcp-savvy` runs locally and uses PKCE — it must be registered as a
**public client**. Entra's UI doesn't let you add `localhost`+port
to the **Mobile and desktop applications** platform directly, so the
working pattern is *add it as Web first, then flip the type in the
manifest*:

1. **Authentication** → **Add a platform** → **Web**
2. Add redirect URI: `http://localhost:33423/callback`
   (`mcp-savvy` defaults to port 33423; if your existing app reg has
   a different port wired up, set `MCP_SAVVY_CALLBACK_PORT` in `.env`
   to match — the redirect URI in the request must match the one
   registered on the app reg)
3. Click **Configure**
4. Scroll to **Advanced settings** → set **Allow public client flows**
   = **Yes**
5. Click **Save**
6. **Manage** → **Manifest** → find `replyUrlsWithType` → change the
   `"type"` from `"Web"` to `"InstalledClient"`:

   ```json
   "replyUrlsWithType": [
       {
           "url": "http://localhost:33423/callback",
           "type": "InstalledClient"
       }
   ]
   ```

7. Click **Save**

> **Why the manifest edit:** `"type": "InstalledClient"` tells Entra
> this is a public PKCE client. With `"type": "Web"` Entra expects a
> client secret on the token exchange and you'll get
> `AADSTS7000218: client_assertion or client_secret required`.

## 2.5. Issue v2.0 access tokens (`accessTokenAcceptedVersion: 2`)

Same manifest, one more edit:

```json
"accessTokenAcceptedVersion": 2
```

(replace the default `null` with the integer `2`). Click **Save**.

> **Why this matters:** Without it, Entra silently issues v1.0
> access tokens whose `iss` claim is
> `https://sts.windows.net/<tenant>/` instead of
> `https://login.microsoftonline.com/<tenant>/v2.0`. AgentCore (and
> any v2-aware authorizer) validates the JWT against the issuer in
> the v2.0 discovery document, so the request gets rejected with
> `Claim 'iss' value mismatch with configuration.` This setting flips
> the app to issue v2.0 tokens whose issuer matches what AgentCore
> expects.

## 3. (Optional) Surface email in tokens

For logging / debugging:

1. **Token configuration** → **Add optional claim** → **ID** → check
   **email** → **Add**

## 4. Wire up `mcp-savvy`

Copy `.env.example` to `.env` (the file is gitignored — it never
leaves your machine):

```bash
cp .env.example .env
```

Add the Entra values:

```bash
ENTRA_TENANT_ID=<your-tenant-uuid>
ENTRA_CLIENT_ID=<your-app-reg-client-uuid>

# Match this to whichever redirect URI you registered above
MCP_SAVVY_CALLBACK_PORT=33423
```## 5. Deploy and validate

Deploy a parallel AgentCore Runtime gated by your Entra tenant
(coexists with the Cognito-gated one — separate stack, separate
runtime ID):

```bash
make example-minimal-entra-deploy
```

Print the client config the deploy produced:

```bash
make example-minimal-entra-config
```

Run the end-to-end smoke test (PKCE sign-in → token cached in keychain
→ MCP `initialize` + `tools/list` + `echo` round-trip):

```bash
make example-minimal-entra-smoke
```

When the browser opens, sign in with an account from your tenant.

## Troubleshooting

### `AADSTS7000218: client_assertion or client_secret required`

Entra still thinks the app is a confidential (Web) client. Re-do
step 2.6 — set the manifest's `replyUrlsWithType[].type` to
`InstalledClient` and save.

### `AADSTS500113: No reply address is registered for the application`

The redirect URI in the request doesn't match anything registered
on the app. Check that the URL `mcp-savvy` advertises matches the
manifest entry character-for-character. The advertised URL is built
from `MCP_SAVVY_CALLBACK_HOST` (default `localhost`) and
`MCP_SAVVY_CALLBACK_PORT` (default `33423`). If the redirect URI
you registered uses a different host or port, set the corresponding
env var in `.env` to match.

### `AADSTS65001: The user or administrator has not consented`

You need admin consent (or interactive user consent) for the scopes
the client requests. Go to **API permissions** → **Grant admin
consent for <tenant>**.

### Smoke test reaches PKCE but fails on `initialize`

The PKCE flow succeeded (you got a token cached) but AgentCore
rejected it. Most common causes:

- `Claim 'iss' value mismatch with configuration.` — your app reg is
  still issuing v1.0 access tokens (`iss: https://sts.windows.net/...`)
  but the discovery URL we registered with AgentCore declares the
  v2.0 issuer. Fix: edit the app registration manifest, set
  `"accessTokenAcceptedVersion": 2`, save. See section 2.5 above.
- `Claim 'client_id' value mismatch with configuration.` — Entra
  v2.0 access tokens DO NOT include a `client_id` claim. They use
  `azp` (authorized party) instead. The fix on our side is to
  configure the JWT authorizer with `customClaims` rule on `azp`
  (which `bin/app.ts` already does for `MCP_SAVVY_DEMO_IDP=entra`)
  and to leave `allowedClients` unset on the JWT authorizer.
- After clearing the manifest fix above, **clear the cached token**
  before re-running the smoke: `make example-minimal-entra-logout`.
  Stale v1.0 tokens will keep failing until they expire.
- `aud` claim mismatch. Decode the JWT at <https://jwt.ms> — the
  `aud` claim must match the `allowedAudience` in the JWT
  authorizer. Defaults to the raw client ID; override with
  `ENTRA_AUDIENCE` in `.env` if you've gone through *Expose an API*
  to set up `api://<clientId>` as the audience instead.
- Scope didn't include a resource scope. The Makefile requests
  `<clientId>/.default` so the access token's `aud` is the client
  ID itself. If you customized scopes, make sure at least one of
  them resolves to a resource the user has consented to.

> Helpful diagnostic: run
> `node scripts/decode-cached-token.mjs` after `make example-minimal-entra-login`
> with the same env vars to dump the cached JWT's claims, then
> compare against the authorizer config in `bin/app.ts`.

### `Login pages unavailable`

Entra returns this only for misconfigured redirect URIs. Re-check
that the URI in `.env` (`MCP_SAVVY_CALLBACK_PORT`) matches the
manifest entry.
