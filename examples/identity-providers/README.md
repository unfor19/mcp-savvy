# Identity providers for `mcp-savvy`

`mcp-savvy` never ships its own identity provider. The bridge and
every example are IdP-agnostic: anything that speaks OIDC + PKCE works
on the client side, and the `@mcp-savvy/cdk` constructs gate the
backend with a JWT authorizer pointed at the same issuer.

This page is the hub for wiring a specific IdP. Cognito is the bundled
default so a fresh clone deploys with zero IdP config; everything else
is a two-part swap — a client env block and a one-line CDK factory.

## The two adoption paths

Pick the one that matches what your org already runs:

| You have…                          | Use…                            | What it does                                                                  |
| ---------------------------------- | ------------------------------- | ----------------------------------------------------------------------------- |
| nothing yet (just want a demo)     | `new CognitoAuth(...)`          | provisions a fresh Cognito user pool + managed login UI                       |
| an existing **Cognito** user pool  | `importCognito(...)`            | references your pool by ID — no `AWS::Cognito::*` resources, no deletion      |
| an external **SSO** (Entra/Okta/…) | `externalOidc(...)` or a preset | creates nothing in AWS — just a JWT authorizer at your issuer's discovery URL |

Bringing your own corporate SSO is the common production path: one
shared IdP gates every protected MCP your team ships.

## Client side (the `npx mcp-savvy` bridge)

Three env vars regardless of IdP — only the values change:

```bash
MCP_SAVVY_PROVIDER=oidc          # cognito | oidc
MCP_SAVVY_OIDC_ISSUER=<issuer>   # the `iss` your IdP signs
MCP_SAVVY_CLIENT_ID=<client-id>  # a public PKCE client, no secret
```

See [`.env.example`](../../.env.example) for the full set.

## Backend side (the CDK factory)

Each IdP has a preset that encodes its quirks so you don't have to
memorize them. The quirks that matter are the **issuer URL shape** and
**which claim carries the client id** (it isn't always `client_id`).

| IdP                | Preset                          | Issuer template                                        | Client-id claim | Audience default          |
| ------------------ | ------------------------------- | ------------------------------------------------------ | --------------- | ------------------------- |
| AWS Cognito        | `CognitoAuth` / `importCognito` | `https://cognito-idp.<region>.amazonaws.com/<pool-id>` | `client_id`     | client id                 |
| Microsoft Entra ID | `entraExternalOidc(...)`        | `https://login.microsoftonline.com/<tenant>/v2.0`      | `azp`           | client id (`api://…` opt) |
| Okta               | `oktaExternalOidc(...)`         | `https://<domain>/oauth2/default`                      | `cid`           | `api://default`           |
| Auth0              | `auth0ExternalOidc(...)`        | `https://<domain>/`                                    | `azp`           | **required** (API id)     |
| Keycloak           | `keycloakExternalOidc(...)`     | `https://<host>/realms/<realm>`                        | `azp`           | none (mapper to opt in)   |

All of these take a public PKCE client (no secret) and register
`http://localhost:33423/callback` as a redirect URI.

### Microsoft Entra ID

```ts
import { entraExternalOidc } from '@mcp-savvy/cdk';

const idp = entraExternalOidc({
  tenantId: process.env.ENTRA_TENANT_ID!,
  clientId: process.env.ENTRA_CLIENT_ID!,
  // audience: `api://${clientId}`,  // only if you exposed an API
});
```

Entra v2 access tokens carry the client in `azp`, not `client_id`, and
need `accessTokenAcceptedVersion: 2` in the app-reg manifest.
**Full portal walkthrough: [entra.md](./entra.md).**

### Okta

```ts
import { oktaExternalOidc } from '@mcp-savvy/cdk';

const idp = oktaExternalOidc({
  domain: 'dev-123.okta.com',
  clientId: process.env.OKTA_CLIENT_ID!,
  // authorizationServerId: 'aus...',     // non-default custom server
  // audience: 'https://mcp.example.com', // its configured Audience
});
```

Register an **OIDC → Native Application** (PKCE). The issuer is the
custom authorization server (`/oauth2/default`), not the org server
(the bare domain) — the org server can't customize `aud` and is meant
for Okta's own APIs. Okta puts the client id in the `cid` claim.

### Auth0

```ts
import { auth0ExternalOidc } from '@mcp-savvy/cdk';

const idp = auth0ExternalOidc({
  domain: 'my-tenant.us.auth0.com',
  clientId: process.env.AUTH0_CLIENT_ID!,
  audience: 'https://mcp.example.com', // REQUIRED — an API Identifier
});
```

Register a **Native** application (PKCE). The `audience` is not
optional: without an API Identifier, Auth0 issues an *opaque* access
token instead of a JWT and no authorizer can validate it. Client id
rides in `azp`.

### Keycloak

```ts
import { keycloakExternalOidc } from '@mcp-savvy/cdk';

const idp = keycloakExternalOidc({
  baseUrl: 'https://keycloak.example.com',
  realm: 'my-realm',
  clientId: process.env.KEYCLOAK_CLIENT_ID!,
  // audience: 'mcp-api', // only if you added an audience mapper
});
```

Register a public client with PKCE enabled. Keycloak puts the client
id in `azp`. By default the `aud` claim doesn't include your client,
so audience validation is skipped — add a client-scope **audience
mapper** and pass `audience` if you want it enforced.

## Any other OIDC IdP

No preset? Use the raw factory and set the claim binding yourself:

```ts
import { externalOidc } from '@mcp-savvy/cdk';

const idp = externalOidc({
  issuer: 'https://idp.example.com',
  allowedAudience: ['<audience>'],
  customClaim: { name: 'azp', value: '<client-id>' }, // or { name: 'cid', ... }
});
```

Then pass `idp` to any construct: `new AgentCoreRuntime(this, 'Runtime',
{ identityProvider: idp, ... })`. The same `IdentityProvider` flows
into `AgentCoreGateway` and `OAuthCompleteSessionApi` unchanged.
