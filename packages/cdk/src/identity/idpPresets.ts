/**
 * Vendor-specific presets over `externalOidc`.
 *
 * Each preset encodes the quirks that make a given IdP's access tokens
 * validate correctly against the AgentCore JWT authorizer and the
 * generic Lambda authorizer:
 *   - the exact issuer URL shape the IdP signs into `iss`, and
 *   - which claim carries the authorizing client ID (`client_id` is
 *     not universal: Entra v2 uses `azp`, Okta uses `cid`, Auth0 and
 *     Keycloak use `azp`).
 *
 * Callers who don't want to memorize these reach for the preset; the
 * raw `externalOidc(...)` factory stays available for IdPs without one.
 */

import { externalOidc, type ExternalOidcIdentityProvider } from './identityProvider.js';

/** Inputs for `entraExternalOidc`. */
export interface EntraOidcOptions {
    /** Microsoft Entra tenant GUID (or verified domain). */
    readonly tenantId: string;
    /** App registration client ID — must be a public client (PKCE, no secret). */
    readonly clientId: string;
    /**
     * Optional `aud` override. Defaults to `clientId`, which is what
     * Entra v2 access tokens carry when the app registration is set up
     * as `accessTokenAcceptedVersion: 2`. Override only when a resource
     * server has been registered with a different audience
     * (e.g. `api://<clientId>`).
     */
    readonly audience?: string;
}

/**
 * Build an external-OIDC provider for a Microsoft Entra ID v2.0 tenant.
 *
 * Encodes the two Entra-specific quirks documented in
 * `examples/identity-providers/entra.md`:
 *   1. `accessTokenAcceptedVersion: 2` in the app-reg manifest yields
 *      v2 access tokens. v2 tokens carry the authorized-party claim in
 *      `azp`, NOT in `client_id`, so we bind a `customClaim` on `azp`
 *      rather than `allowedClients`.
 *   2. The audience defaults to the bare `clientId`. Override only when
 *      a resource server has been registered with an `api://...` audience.
 *
 * Example:
 * ```
 * const idp = entraExternalOidc({
 *   tenantId: process.env.ENTRA_TENANT_ID!,
 *   clientId: process.env.ENTRA_CLIENT_ID!,
 * });
 * new AgentCoreRuntime(this, 'Runtime', { identityProvider: idp, ... });
 * ```
 */
export function entraExternalOidc(opts: EntraOidcOptions): ExternalOidcIdentityProvider {
    const audience = opts.audience ?? opts.clientId;
    return externalOidc({
        issuer: `https://login.microsoftonline.com/${opts.tenantId}/v2.0`,
        allowedAudience: [audience],
        customClaim: { name: 'azp', value: opts.clientId },
    });
}

/** Inputs for `oktaExternalOidc`. */
export interface OktaOidcOptions {
    /**
     * Okta org domain — `dev-123.okta.com` or a full `https://…` URL.
     * Custom domains (`id.example.com`) work too.
     */
    readonly domain: string;
    /** OIDC app client ID — must be a public (PKCE, no secret) Native app. */
    readonly clientId: string;
    /**
     * Custom authorization-server ID. Defaults to `default` (Okta's
     * built-in custom authorization server). The issuer becomes
     * `https://<domain>/oauth2/<authorizationServerId>`. For the Org
     * Authorization Server (issuer = the bare domain, no `/oauth2/...`),
     * use `externalOidc(...)` directly with the Org server's audience
     * and `cid` client binding — its tokens are intended for Okta's own
     * APIs and can't customize `aud`.
     */
    readonly authorizationServerId?: string;
    /**
     * Expected `aud` claim. Defaults to `api://default`, the audience of
     * Okta's built-in default custom authorization server. Override to
     * the Audience configured on a non-default custom auth server.
     */
    readonly audience?: string;
}

/**
 * Build an external-OIDC provider for an Okta custom authorization server.
 *
 * Okta-specific quirks:
 *   1. Access tokens carry the client ID in the `cid` claim — not
 *      `client_id`, not `azp` — so we bind a `customClaim` on `cid`.
 *      ([Okta authorization servers](https://developer.okta.com/docs/reference/api/authorization-servers/))
 *   2. The issuer is the custom-auth-server URL
 *      (`https://<domain>/oauth2/default`), distinct from the Org
 *      Authorization Server (the bare domain). The `default` server's
 *      audience is `api://default`.
 *
 * Example:
 * ```
 * const idp = oktaExternalOidc({
 *   domain: 'dev-123.okta.com',
 *   clientId: process.env.OKTA_CLIENT_ID!,
 * });
 * ```
 */
export function oktaExternalOidc(opts: OktaOidcOptions): ExternalOidcIdentityProvider {
    const host = opts.domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const authServerId = opts.authorizationServerId ?? 'default';
    const audience = opts.audience ?? 'api://default';
    return externalOidc({
        issuer: `https://${host}/oauth2/${authServerId}`,
        allowedAudience: [audience],
        customClaim: { name: 'cid', value: opts.clientId },
    });
}

/** Inputs for `auth0ExternalOidc`. */
export interface Auth0OidcOptions {
    /** Auth0 tenant domain — `my-tenant.us.auth0.com` or a full `https://…` URL. */
    readonly domain: string;
    /** Application client ID — must be a Native / public (PKCE) client. */
    readonly clientId: string;
    /**
     * The API Identifier (audience) registered under Auth0 → APIs.
     * **Required**: without an `audience`, Auth0 returns an opaque
     * access token (not a JWT), which no JWT authorizer can validate.
     */
    readonly audience: string;
}

/**
 * Build an external-OIDC provider for an Auth0 tenant.
 *
 * Auth0-specific quirks:
 *   1. You MUST request an `audience` (an API Identifier). Without one,
 *      Auth0 issues an opaque access token rather than a JWT.
 *      ([Auth0 access tokens](https://auth0.com/docs/secure/tokens/access-tokens))
 *   2. Access tokens carry the client ID in `azp`, not `client_id`, so
 *      we bind a `customClaim` on `azp`.
 *   3. Auth0's `iss` ends in a trailing slash (`https://<domain>/`); the
 *      Lambda authorizer accepts the issuer with or without it.
 *
 * Example:
 * ```
 * const idp = auth0ExternalOidc({
 *   domain: 'my-tenant.us.auth0.com',
 *   clientId: process.env.AUTH0_CLIENT_ID!,
 *   audience: 'https://mcp.example.com',
 * });
 * ```
 */
export function auth0ExternalOidc(opts: Auth0OidcOptions): ExternalOidcIdentityProvider {
    const host = opts.domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return externalOidc({
        issuer: `https://${host}`,
        allowedAudience: [opts.audience],
        customClaim: { name: 'azp', value: opts.clientId },
    });
}

/** Inputs for `keycloakExternalOidc`. */
export interface KeycloakOidcOptions {
    /** Keycloak base URL, e.g. `https://keycloak.example.com` (no realm path). */
    readonly baseUrl: string;
    /** Realm name — the issuer becomes `<baseUrl>/realms/<realm>`. */
    readonly realm: string;
    /** OIDC client ID — must be a public client with PKCE enabled. */
    readonly clientId: string;
    /**
     * Expected `aud` claim. Optional: by default Keycloak access tokens
     * do NOT carry the client as an audience, so we skip `aud` validation
     * and rely on issuer + `azp`. Set this only if you've added an
     * audience mapper / client scope that injects the value.
     */
    readonly audience?: string;
}

/**
 * Build an external-OIDC provider for a Keycloak realm.
 *
 * Keycloak-specific quirks:
 *   1. Access tokens carry the client ID in `azp`, not `client_id`, so
 *      we bind a `customClaim` on `azp`.
 *   2. By default the `aud` claim does NOT include the client, so
 *      audience validation is skipped unless you pass `audience` (which
 *      requires a Keycloak audience mapper to be configured).
 *      ([Keycloak audience config](https://stackoverflow.com/questions/71507773/keycloak-define-audience-for-jwt))
 *
 * Example:
 * ```
 * const idp = keycloakExternalOidc({
 *   baseUrl: 'https://keycloak.example.com',
 *   realm: 'my-realm',
 *   clientId: process.env.KEYCLOAK_CLIENT_ID!,
 * });
 * ```
 */
export function keycloakExternalOidc(
    opts: KeycloakOidcOptions,
): ExternalOidcIdentityProvider {
    const base = opts.baseUrl.replace(/\/$/, '');
    return externalOidc({
        issuer: `${base}/realms/${opts.realm}`,
        ...(opts.audience !== undefined ? { allowedAudience: [opts.audience] } : {}),
        customClaim: { name: 'azp', value: opts.clientId },
    });
}
