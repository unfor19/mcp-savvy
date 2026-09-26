# Okta → AgentCore Gateway → AWS for SAP MCP → SAP contracts

This document separates the deployable service-identity path from the desired
named-user SSO path. It records only contracts verified in current AWS, Okta,
repo, or shipped-template sources as of 2026-09-15.

## Support verdict

| Capability                               | Status                                             | Evidence                                                                      |
| ---------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| Okta JWT into AgentCore Gateway          | Supported                                          | AgentCore accepts Okta/custom OIDC; this repo binds `aud` + `cid`.            |
| Gateway to an OAuth-protected MCP target | Supported                                          | MCP targets accept client credentials, authorization code, or token exchange. |
| AWS for SAP MCP inbound Cognito          | Supported by stock template                        | Template creates a client-credentials app and Runtime JWT authorizer.         |
| AWS for SAP MCP inbound Okta             | **Not exposed by stock v1.0.0 template**           | `InboundAuthProvider.AllowedValues` is only `Cognito`, `EntraId`.             |
| SAP MCP outbound BASIC/M2M               | Supported                                          | Documented stock flows for S/4HANA and ECC.                                   |
| SAP MCP outbound Okta OBO                | **Not supported by the stock deployment contract** | OBO docs/template path is Microsoft/Entra-specific.                           |
| Okta named user preserved into SAP       | Architecturally possible, not stock-deployable     | Requires two Okta token exchanges and SAP OIDC trust.                         |

Do not use `InboundAuthProvider=EntraId` with Okta endpoints and call that
supported. The generated Runtime authorizer is technically generic, but the
vendor template's accepted value, deployment logic, tests, and OBO provider
remain Entra-specific.

## Path A: deployable service identity

```text
Okta user token A
  -> AgentCore Gateway
  -> Cognito M2M token B
  -> AWS for SAP MCP Runtime
  -> SAP technical credential/token C
  -> SAP OData V2
```

### Boundary 1: mcp-savvy ↔ Okta

The client is an Okta **Native OIDC application** with no client secret.

Authorization request:

```text
GET https://<domain>/oauth2/<server-id>/v1/authorize
  response_type=code
  client_id=<OKTA_CLIENT_ID>
  redirect_uri=http://localhost:33423/callback
  code_challenge=<S256 challenge>
  code_challenge_method=S256
  scope=openid profile email offline_access
  state=<random correlation value>
```

The client exchanges the one-time code at `/v1/token` with its
`code_verifier`. The result used at Gateway is the **access token**, not the ID
token. Required token-A claims are:

| Claim | Contract                                                                               |
| ----- | -------------------------------------------------------------------------------------- |
| `iss` | Exact custom authorization-server URL. Do not use the bare Okta org issuer.            |
| `aud` | Exact `OKTA_AUDIENCE` configured on that authorization server.                         |
| `cid` | Exact Native app client ID; this repo binds it as a custom claim.                      |
| `sub` | Authenticated Okta user.                                                               |
| `exp` | Must be current.                                                                       |
| `scp` | Requested scopes; this demo does not use scopes as its Gateway authorization decision. |

### Boundary 2: mcp-savvy ↔ AgentCore Gateway

```http
POST https://<gateway-id>.gateway.bedrock-agentcore.<region>.amazonaws.com/mcp
Authorization: Bearer <Okta access token A>
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2025-06-18
```

The body is MCP JSON-RPC (`initialize`, `tools/list`, or `tools/call`). The
Gateway custom-JWT authorizer resolves Okta discovery/JWKS and validates
signature, expiry, `iss`, `aud`, and `cid` before routing the request.

The bridge normally negotiates `2025-06-18`; the example Gateway accepts both
`2025-06-18` and `2025-11-25`. Supporting only `2025-11-25` would reject the
normal non-3LO bridge contract.

### Boundary 3: Gateway ↔ AgentCore Identity ↔ Cognito

The native MCP target references these non-secret identifiers:

```text
providerArn = arn:aws:acps:<region>:<account>:token-vault/<vault>/oauth2credentialprovider/<name>
secretArn   = <response.clientSecretArn.secretArn>
grantType  = CLIENT_CREDENTIALS
scopes      = awsforsap-mcp-m2m-resource-server-<id>/read
```

AgentCore Identity performs this logical token request with the managed client
secret:

```http
POST https://<cognito-domain>.auth.<region>.amazoncognito.com/oauth2/token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64(<client-id>:<client-secret>)

grant_type=client_credentials&scope=<resource-server>/read
```

Cognito returns only `access_token`, `token_type=Bearer`, and `expires_in` for
this grant. The token authorizes the **app client**, not the Okta user. Do not
depend on a human `sub` or infer user propagation from this token. The stock SAP
MCP Runtime authorizer validates the token against its Cognito discovery URL and
allowed client ID.

The provider, secret, Gateway, and SAP MCP Runtime must be in the same AWS
account and Region where the target is created.

### Boundary 4: Gateway ↔ AWS for SAP MCP Runtime

Gateway sends Streamable HTTP MCP requests to the encoded Runtime URL:

```http
POST https://bedrock-agentcore.<region>.amazonaws.com/runtimes/<url-encoded-arn>/invocations?qualifier=DEFAULT
Authorization: Bearer <Cognito access token B>
Content-Type: application/json
Accept: application/json, text/event-stream
```

AgentCore Runtime validates token B, then passes the MCP payload through to the
container at `0.0.0.0:8000/mcp`. The SAP server is stateless. On target create
or update, Gateway invokes `tools/list` and caches the catalog; client
`tools/list` is then served from Gateway. Tool calls are routed live and names
are prefixed `sap___`.

The published read tools are `find_sap_services`, `get_metadata`, `odata_read`,
and `odata_count`. Their exact input schemas are runtime contracts discovered
through `tools/list`; this repo intentionally does not duplicate or guess them.

### Boundary 5: AWS for SAP MCP ↔ SAP

Choose one technical-principal mode for this scaffold:

| Mode  | Credential input                      | Wire authorization                      | SAP principal                 |
| ----- | ------------------------------------- | --------------------------------------- | ----------------------------- |
| BASIC | Secrets Manager `{username,password}` | HTTPS Basic authentication              | SAP system user               |
| M2M   | AgentCore OAuth provider + SAP scopes | HTTPS `Authorization: Bearer <token C>` | OAuth client/service identity |

The server maps MCP tools to SAP OData V2 HTTPS calls. Exact OData service paths,
query options, CSRF behavior, and response schema depend on the live SAP service
metadata. Keep all write flags disabled. SAP never receives token A in Path A.

## Path B: named-user Okta SSO

The identity-preserving contract requires three audience boundaries:

```text
A: iss=Okta gateway AS, aud=gateway, sub=user, cid=native-client
  -> Gateway RFC 8693 exchange
B: iss=Okta SAP-MCP AS, aud=sap-mcp, sub=same user, cid=gateway-delegate
  -> SAP MCP Runtime RFC 8693 exchange
C: iss=Okta SAP AS, aud=sap, sub=same user, cid=sap-mcp-delegate
  -> SAP OIDC trust and named-user mapping
```

Each exchange uses a confidential Okta service app and logically sends:

```text
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token=<upstream access token>
subject_token_type=urn:ietf:params:oauth:token-type:access_token
audience=<downstream audience>
scope=<downstream scopes>
```

Okta requires the `audience` and `subject_token_type` custom parameters. For
separate custom authorization servers in one tenant, configure trusted-server
relationships and access policies. SAP S/4HANA must trust token C's issuer/JWKS,
validate its audience, and map a stable user claim to an SAP user.

This path is **not implemented or claimed by this example**. Generic AgentCore
Gateway, Runtime, Identity, and Okta support the primitives, but the stock AWS
for SAP MCP deployment currently blocks the composition:

1. `InboundAuthProvider` rejects `Okta` at CloudFormation validation.
2. The stock OBO path creates/configures a Microsoft OAuth provider.
3. The template does not accept an existing arbitrary OBO provider name.
4. AWS documents the SAP OIDC/OBO procedure for Entra, not Okta.

A custom deployment would need to own the SAP MCP Runtime authorizer, exact
`CustomOauth2` provider, environment wiring, SAP trust, and live contract tests.

## Likely prior-integration failure points

| Symptom                            | High-signal check                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| CloudFormation rejects parameters  | `InboundAuthProvider=Okta` is invalid in stock v1.0.0.                                         |
| Gateway returns 401                | Decode locally: token must be access JWT with exact `iss`, `aud`, `cid`, unexpired `exp`.      |
| Gateway rejects MCP request        | Header/body version must be in Gateway `supportedVersions`; bridge normally uses `2025-06-18`. |
| Target create stays failed/pending | Provider/secret must exist in same account/Region; endpoint must be encoded HTTPS.             |
| Cognito returns `invalid_scope`    | Use the exact SAP stack resource-server identifier plus `/read`.                               |
| SAP Runtime returns 401            | Token B `client_id` must match the stock template's allowed Cognito client.                    |
| SAP returns 401/403                | Validate SAP OAuth scope/role, issuer/audience, and user mapping at SAP—not Gateway.           |
| SAP audit shows one service user   | Expected in Path A; only OBO/user federation can preserve a human.                             |
| OBO silently loses user context    | A client-credentials token replaced the user token at an earlier hop.                          |

## Primary sources

- [AgentCore Gateway MCP calls](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-using-mcp-call.html)
- [AgentCore MCP server targets](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-MCPservers.html)
- [AgentCore Runtime MCP hosting](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html)
- [AgentCore Okta configuration](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity-idp-okta.html)
- [AgentCore OAuth provider API](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CreateOauth2CredentialProvider.html)
- [Cognito token endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html)
- [AWS for SAP MCP authentication](https://docs.aws.amazon.com/mcp-sap/latest/awsforsapmcp/identity-and-authentication.html)
- [AWS for SAP MCP deployment](https://docs.aws.amazon.com/mcp-sap/latest/awsforsapmcp/deployment.html)
- [AWS for SAP MCP security](https://docs.aws.amazon.com/mcp-sap/latest/awsforsapmcp/security.html)
- [AWS SAP named-user OBO walkthrough](https://aws.amazon.com/blogs/awsforsap/achieving-single-sign-on-agentic-access-to-sap-with-aws-for-sap-mcp-server/)
- [Okta OBO token exchange](https://developer.okta.com/docs/guides/set-up-token-exchange/main/)

Content was rephrased for compliance with licensing restrictions.
