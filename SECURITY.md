# Security

`mcp-savvy` ships a CLI that handles real OAuth tokens and a CDK
toolkit that stands up real cloud resources. Security is the
primary design driver. This document covers what we defend against,
how we defend against it, and what's explicitly out of scope.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security
vulnerabilities. Use GitHub's
[private vulnerability reporting form](https://github.com/unfor19/mcp-savvy/security/advisories/new)
with:

- A description of the issue
- Steps to reproduce
- The version (`npx -y mcp-savvy --print-env` — the client ID is
  redacted)

We'll acknowledge within 72 hours and aim for a fix within 14 days
for high-severity reports.

## CLI: token handling

### Loopback callback server

The local OAuth callback server **binds to `127.0.0.1` only**, never
`0.0.0.0`. This is a hard requirement, not a configurable default —
the `listen()` call passes `'127.0.0.1'` as the host argument
explicitly. Remote hosts cannot reach the callback. Same-host processes
can reach loopback, so OAuth state correlation and PKCE remain required.

The advertised URL (the value sent to the IdP as `redirect_uri`)
defaults to `http://localhost:<port>/callback`. `localhost` resolves
to the loopback adapter on every modern OS, so the bind is still
secure. We default to `localhost` (not `127.0.0.1`) in the
advertised URL because IdPs have historically been pickier about
the literal string match between registered and runtime redirect
URIs — and `localhost` is what most consoles default to. If your
IdP's registered URI uses `127.0.0.1`, set
`MCP_SAVVY_CALLBACK_HOST=127.0.0.1`.

This split (`localhost` advertised, `127.0.0.1` bound) follows the
guidance in
[RFC 8252 section 7.3](https://datatracker.ietf.org/doc/html/rfc8252#section-7.3)
("Loopback Interface Redirection") which permits both forms while
recommending the loopback IP literal for the actual bind.

### CSRF protection

The OAuth `state` parameter is compared with
[`crypto.timingSafeEqual`](https://nodejs.org/api/crypto.html#cryptotimingsafeequalbuffer1-buffer2)
over equal-length buffers. Mismatched length short-circuits to a
rejection without leaking timing information. A callback with a
missing or incorrect state receives a 400 response but does not end
the active sign-in; only a correlated callback or the hard timeout
settles the listener.

### One-shot self-close

The callback server accepts exactly **one** valid callback then
shuts down. Subsequent requests get a 404. There's also a hard
timeout (default 5 minutes) after which the server closes whether
or not a callback arrived.

### Response hardening

Every response carries:

- `Cache-Control: no-store`
- `Referrer-Policy: no-referrer`
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`

Every IdP-supplied value (error messages, tenant names, etc.) is
HTML-escaped before reaching the success or error page — see
[OWASP XSS Prevention Cheat Sheet, rule #1](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html).

### Sensitive logging

Authorization URLs and callback correlation values are passed only
to the browser and protocol handlers, not diagnostic logs. The
complete-session API records structured outcomes using truncated
SHA-256 fingerprints for correlation; it does not log bearer tokens,
raw subjects, session URIs, or upstream error messages. The repository
secret scanner likewise reports only the file, source, and finding
kind, never bytes from the matched value.

### Token storage

#### Keychain (default)

We use the OS-native keychain when available:

- **macOS** — [`security`](https://ss64.com/osx/security.html) (Keychain Access)
- **Windows** — `cmdkey` + PowerShell against
  [Credential Manager](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2008-R2-and-2008/cc754796(v=ws.11))
- **Linux** —
  [`secret-tool`](https://gnome.pages.gitlab.gnome.org/libsecret/secret-tool.1.html)
  (libsecret, GNOME Keyring / KWallet)

We **shell out** to these binaries rather than using a native Node
module like [`keytar`](https://github.com/atom/node-keytar).
`keytar` is unmaintained as of [its archival in 2023](https://github.com/atom/node-keytar/issues/418)
and pulls `node-gyp` which makes `npx mcp-savvy` painful to install.
Shelling out is portable, install-free, and the binaries are
already on the box.

#### Encrypted-file fallback

When no keychain is available, tokens are AES-256-CBC encrypted with
a key derived from machine-bound material via
[`scrypt`](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback).
This is **defense in depth**, not a security boundary against a
local attacker — see "Out of scope" below.

The token namespace defaults to a slug of the issuer host plus the
first 8 chars of `sha256(clientId)`, so two protected MCPs on the
same machine never share a keychain entry.

### PKCE

Sign-in uses [PKCE](https://datatracker.ietf.org/doc/html/rfc7636)
with the `S256` code challenge method. We're a public client (no
client secret); PKCE is the protection against authorization-code
interception attacks.

### Outbound endpoint security

Remote MCP, OIDC issuer, discovered authorization/token, Gateway
authorization, and complete-session endpoints must use HTTPS. Exact
loopback HTTP (`localhost`, `127.0.0.1`, or `[::1]`) remains available
for local development and registered callback flows. An HTTPS issuer
cannot downgrade discovered endpoints to loopback HTTP.

OIDC discovery requires the document's `issuer` field to exactly match
the configured issuer before any endpoint is trusted. Credential-bearing
HTTP clients reject redirects so an accepted HTTPS URL cannot forward a
Bearer token, authorization code, PKCE verifier, or refresh token to a
different destination.

## CDK: backend hardening

### `cdk-nag` clean by default

Every construct in `@mcp-savvy/cdk` is checked against the
[`AwsSolutions` rule pack from `cdk-nag`](https://github.com/cdklabs/cdk-nag/blob/main/RULES.md#awssolutions)
and synthesizes without warnings on `cdk synth --strict`. Any
acknowledged warnings (e.g. AWS L2 quirks we can't avoid) are
documented per-construct with a citation to the AWS docs.

`cdk-nag` is the
[official CDK Labs](https://github.com/cdklabs/cdk-nag) tool for
checking CDK applications against AWS Solutions Library, HIPAA, NIST
800-53, and PCI rule packs. AWS Prescriptive Guidance recommends it
for production CDK apps —
[reference](https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/check-aws-cdk-applications-or-cloudformation-templates-for-best-practices-by-using-cdk-nag-rule-packs.html).

### Identity provider pluggability

The `IdentityProvider` abstraction (Cognito vs. external OIDC)
makes the JWT-authorizer wiring identical regardless of IdP. No
provider-specific secrets, no provider-specific code paths in your
agent — the IdP is a config choice, not an architectural decision.

### Public-client only

CDK constructs only configure **public** OIDC clients (no client
secret stored in CloudFormation, no secret material in the
synthesized template). Authentication relies on PKCE; resource
authorization relies on JWT signatures verified against the IdP's
JWKS endpoint at the API Gateway layer.

### Loopback URLs registered up front

For 3LO flows, the bridge's loopback callback URLs (default
`http://localhost:33424/oauth2/callback`) are registered as
`AllowedResourceOAuth2ReturnUrl` on the gateway's workload identity
at deploy time via a small custom-resource Lambda. No runtime
mutation of IAM-scoped resources from a long-lived process.

## Out of scope (and why)

- **Local privilege boundary.** Any code running as the same OS
  user can read the keychain entry. That's an OS-level limit, not
  something a CLI can fix. Run untrusted code in a VM or container.
- **DNS rebinding against `127.0.0.1`.** Modern browsers
  ([Chrome](https://chromestatus.com/feature/5706114180874240),
  [Firefox](https://bugzilla.mozilla.org/show_bug.cgi?id=1481298))
  block rebinding for loopback. If your DNS resolver is
  misconfigured to allow it, that's a bigger problem than this tool.
- **HTTPS on the loopback callback.** Cognito and other major IdPs
  accept `http://127.0.0.1:*/...` for loopback per
  [RFC 8252 section 8.3](https://datatracker.ietf.org/doc/html/rfc8252#section-8.3),
  so we keep HTTP and rely on the loopback bind + CSRF check + short
  token lifetime. Issuing a self-signed cert per session would be
  worse UX with no real security gain on a loopback interface.
- **Refresh-token rotation enforcement at the IdP.** Some IdPs
  rotate refresh tokens; some don't. We honor whatever the IdP
  returns. Configure rotation at the IdP if you need it.
- **MFA enforcement.** For Cognito, our `CognitoAuth` construct
  defaults to `mfaRequired: true` (TOTP). For external IdPs, MFA is
  the IdP's responsibility — `mcp-savvy` doesn't second-guess it.

## See also

- [AGENTS.md](./AGENTS.md) — operating rules for agents in this repo
  (covers secrets handling, dependency policy, etc.)
