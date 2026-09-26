# AgentCore interactive OAuth

## Short version

When an AgentCore tool needs user authorization, mcp-savvy opens the one-time authorization URL, receives the localhost return, completes AgentCore's user/session binding, and retries the original tool once.

For the tested AWS for SAP flow, this means the Okta-authenticated caller can initiate SAP user federation and obtain a user-bound SAP resource token. A successful SAP catalog call proves that the completed resource credential was usable. It does **not**, by itself, prove that SAP audited the request as the same human who signed in to the outer Okta application. That final claim requires SAP audit evidence and a two-user isolation test.

## Supported authorization responses

AgentCore currently exposes interactive resource authorization in at least two MCP response shapes:

- Gateway targets return JSON-RPC error `-32042` with a URL elicitation.
- The tested AWS for SAP Runtime returns a successful tool-result envelope with:

```text
result.structuredContent.result.data.requires_user_action = true
result.structuredContent.result.data.auth_url = <one-time URL>
```

Set `MCP_SAVVY_COMPLETE_SESSION_URL` when the upstream can return either form. Without it, mcp-savvy intentionally forwards the response and does not start the resource-authorization callback.

## How the flow works

1. The MCP host starts mcp-savvy.
2. mcp-savvy authenticates the human with the configured OIDC provider using Authorization Code + PKCE.
3. It sends that user's access token to the protected AgentCore Gateway or Runtime endpoint.
4. AgentCore validates the token and associates the request with that user identity.
5. When a downstream resource needs consent, AgentCore returns a one-time authorization URL and session URI.
6. mcp-savvy validates the URL, binds `127.0.0.1:33424`, and only then opens the browser.
7. The downstream authorization server authenticates/authorizes a user. In the tested SAP composition, SAP OAuth2 redirects browser authentication to Okta SAML and SAP maps that assertion to a local SAP user.
8. AgentCore redirects the browser to mcp-savvy with `session_id`.
9. mcp-savvy requires `session_id` to exactly match the original `request_uri`.
10. It sends `{sessionUri}` with the current outer user Bearer token to the configured HTTPS completion endpoint.
11. The completion service calls `CompleteResourceTokenAuth`, binding the completed resource authorization to the initiating AgentCore user context.
12. mcp-savvy retries the original MCP tool call once. AgentCore supplies the stored resource token to the Runtime/tool.

The first callback and second callback are distinct:

- OIDC login normally uses port 33423, PKCE, and OAuth `state`.
- AgentCore resource completion uses port 33424, exact one-time session-URI equality, and an authenticated completion request.

## Does SAP act on behalf of the original Okta user?

### What the design guarantees

- The Gateway/Runtime request starts with the OIDC access token for the person who authenticated to the MCP client.
- `CompleteResourceTokenAuth` binds the browser-completed resource authorization to that initiating AgentCore user context.
- SAP `USER_FEDERATION` obtains a user-specific SAP OAuth token rather than a shared client-credentials token.
- SAP applies the roles of the SAP user represented by that SAP token.

### What the successful test proves

- A valid outer Okta user token reached and passed the configured AgentCore boundary.
- The same request context initiated SAP user authorization.
- The localhost callback and protected AgentCore completion succeeded.
- A later `find_sap_services` call used an available SAP resource credential and returned service-catalog metadata.
- No shared BASIC/M2M credential was required for that tested call.

### What it does not yet prove

- That the Okta OIDC subject and the Okta SAML/SAP-mapped identity were the same human in the live run. Browser SSO state can select an already-authenticated account unless policy and test setup control it.
- That SAP's audit log attributed the catalog request to the expected SAP user.
- That user B cannot receive or reuse user A's AgentCore/SAP authorization state.
- That different SAP roles produce the expected allow/deny behavior through the full chain.
- That disabling/revoking either Okta or SAP access takes effect within the required time.

Therefore the accurate current statement is:

> The user-bound authorization path works and can access SAP service metadata. End-to-end same-user attribution and isolation still require SAP audit and two-user evidence.

Do not shorten that to “the original Okta user is proven in SAP” until those tests pass.

## Required identity proof

Use two non-production users with deliberately different SAP permissions:

1. Start from isolated browser profiles or fully cleared Okta/SAP sessions.
2. User A signs into the MCP client and completes SAP authorization.
3. Invoke one explicitly approved read that user A may perform.
4. Capture sanitized SAP audit evidence showing SAP user A; do not copy business payloads or tokens.
5. User B signs into a separate MCP/Gateway session and completes their own SAP authorization.
6. Verify user B cannot inherit user A's AgentCore session, SAP token, or allowed object.
7. Verify user B's permitted operation is audited as SAP user B.
8. Disable or revoke one user and measure behavior against documented token/session lifetimes.
9. Confirm the other user remains unaffected.

If any identity or authorization state crosses users, stop. A successful one-user demo cannot override that failure.

## Retry and duplicate-response behavior

Only one response interceptor may own a JSON-RPC request ID at a time. Overlapping duplicate responses are dropped while completion is active. After one replay, a sequential authorization challenge is forwarded without opening another browser.

Authorization URLs are one-time and short-lived. If a consumed or expired URL returns `Invalid request`, do not refresh it. Start a new MCP tool call to obtain a fresh flow. That generic response is consistent with one-time handling but does not identify the exact rejection reason.

## Security controls

- Both callback listeners bind to `127.0.0.1`, never all interfaces.
- Authorization URLs, callback query strings, session URIs, codes, and bearer tokens are not logged or persisted.
- Completion uses HTTPS and the current user Bearer token; the token is not duplicated in the JSON body.
- The completion endpoint must validate the user token and call `CompleteResourceTokenAuth`. A cosmetic localhost page is not sufficient.
- Callback responses use no-store/no-referrer and browser hardening headers.
- The bridge retries at most once and prevents concurrent duplicate browser/completion side effects.
- Same-user local processes remain inside the OS-user trust boundary; mcp-savvy does not claim isolation from code running as that user.
- Deployments must register the exact loopback return URL on every relevant Gateway or Runtime workload identity.

## Validation coverage

Automated coverage includes:

- Gateway `-32042` and Runtime structured authorization parsing;
- completion inputs and retry behavior;
- exhausted retry handling before browser side effects;
- overlapping same-request response ownership;
- real loopback binding, callback path/method, exact session equality, timeout, and closure;
- completion endpoint URL policy;
- build, typecheck, repository tests, architecture drift, and secret scanning; and
- isolated npm packing plus consumer import/require/CLI/typecheck smoke tests.

Live validation included an external AWS for SAP Runtime authorization, the mcp-savvy completion page, and metadata-only service discovery. It did not include SAP business records, writes, two-user isolation, or SAP audit attribution.

## Local development

A running MCP stdio process does not reload changed source or rebuilt JavaScript. After rebuilding locally, point the MCP entry at `packages/cli/dist/cli.cjs` and fully reconnect the server.

For published use, run the current package through your MCP client's normal `npx -y mcp-savvy` configuration and reconnect after upgrading.
