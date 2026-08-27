/**
 * Identity-provider abstraction.
 *
 * Every example in this repo accepts an `IdentityProvider` so the
 * authentication backend is swappable. The core factories cover the
 * common cases:
 *
 *   - `new CognitoAuth(...)` — provision a fresh Cognito user pool
 *     for a self-contained demo.
 *   - `importCognito(scope, id, opts)` — point at an existing
 *     Cognito user pool you already operate (the corporate-IdP
 *     "bring-your-own-pool" path; teams shipping multiple protected
 *     MCPs typically share one pool across all of them).
 *   - `externalOidc(opts)` — point at any non-Cognito OIDC issuer.
 *
 * Vendor-specific convenience wrappers around `externalOidc`
 * (`entraExternalOidc`, `oktaExternalOidc`, `auth0ExternalOidc`,
 * `keycloakExternalOidc`) live in `idpPresets.ts` — they encode the
 * per-IdP quirks (issuer URL shape, which claim carries the client
 * ID) so callers don't have to.
 *
 * Constructs that need a JWT authorizer ask the provider for an
 * `AuthorizerSpec`; constructs that need to pass user-pool refs
 * (e.g. for the L2 `RuntimeAuthorizerConfiguration.usingCognito()`
 * shortcut) can downcast via the `kind` discriminator.
 */

import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

/**
 * A string-equals rule on a single token claim, used when the IdP
 * carries the authorizing client ID somewhere other than the standard
 * `client_id` claim. Different IdPs use different claim names:
 *   - Microsoft Entra v2.0 → `azp` (authorized party).
 *   - Okta (custom authorization server) → `cid` (client ID).
 * The CDK constructs translate this into a `RuntimeCustomClaim` /
 * `GatewayCustomClaim` on the respective AgentCore authorizer, and the
 * generic Lambda authorizer enforces the same `name`/`value` pair.
 */
export interface CustomClaimRule {
    /** Claim name to inspect, e.g. `azp` (Entra) or `cid` (Okta). */
    readonly name: string;
    /** Required claim value — typically the app/client ID. */
    readonly value: string;
}

/** Generic JWT authorizer parameters that work against any OIDC IdP. */
export interface JwtAuthorizerSpec {
    /**
     * OIDC discovery URL. Must end in `/.well-known/openid-configuration`
     * (AgentCore requirement; HTTP API JWT authorizers also accept it).
     */
    readonly discoveryUrl: string;
    /** OIDC issuer URL (`iss` claim that the IdP signs). */
    readonly issuerUrl: string;
    /** Allowed `aud` claim values, if the IdP populates it. */
    readonly allowedAudience?: string[];
    /**
     * Allowed `client_id` claim values. Some IdPs do NOT include
     * `client_id` in access tokens (Entra v2.0 uses `azp`, Okta uses
     * `cid`) — for those, prefer a `customClaim` rule instead.
     */
    readonly allowedClients?: string[];
    /**
     * A string-equals rule on a non-standard client-ID claim, for IdPs
     * that don't populate `client_id`. The CDK constructs translate
     * this into a custom-claim rule on the AgentCore authorizer; the
     * generic Lambda authorizer enforces the same pair.
     */
    readonly customClaim?: CustomClaimRule;
    /** Required scopes; tokens without one of these are rejected. */
    readonly allowedScopes?: string[];
}

/**
 * Common surface every `IdentityProvider` exposes. Constructs use this
 * shape to wire JWT validation regardless of which factory built it.
 */
export interface IdentityProviderBase {
    /** OIDC issuer URL (`iss` claim). */
    readonly issuerUrl: string;
    /** Generic JWT authorizer spec — works for any L2 that accepts a discovery URL. */
    readonly jwtAuthorizer: JwtAuthorizerSpec;
}

/** Cognito-backed identity provider. Surfaces user pool + client refs. */
export interface CognitoIdentityProvider extends IdentityProviderBase {
    readonly kind: 'cognito';
    readonly userPool: cognito.IUserPool;
    readonly humanClient: cognito.IUserPoolClient;
    /** Cognito-managed Hosted UI base URL, e.g. `https://<prefix>.auth.<region>.amazoncognito.com`. */
    readonly hostedUiUrl: string;
}

/**
 * External OIDC identity provider. No user pool — the IdP lives
 * outside AWS (Entra, Okta, Auth0, Keycloak, etc.).
 */
export interface ExternalOidcIdentityProvider extends IdentityProviderBase {
    readonly kind: 'externalOidc';
}

/** Tagged-union covering every supported identity provider shape. */
export type IdentityProvider = CognitoIdentityProvider | ExternalOidcIdentityProvider;

/** Reject an authorizer spec that can accept tokens without an application binding. */
export function assertJwtAuthorizerBinding(spec: JwtAuthorizerSpec): void {
    const hasAudience = spec.allowedAudience?.some((value) => value.trim().length > 0) ?? false;
    const hasClient = spec.allowedClients?.some((value) => value.trim().length > 0) ?? false;
    const hasCustomClaim =
        spec.customClaim !== undefined &&
        spec.customClaim.name.trim().length > 0 &&
        spec.customClaim.value.trim().length > 0;
    if (!hasAudience && !hasClient && !hasCustomClaim) {
        throw new Error(
            'JWT authorizer requires a non-empty allowedAudience, allowedClients, or customClaim binding',
        );
    }
}

/**
 * Build an `ExternalOidcIdentityProvider` from a raw issuer URL.
 *
 * Most callers should reach for a vendor preset in `idpPresets.ts`
 * (`entraExternalOidc`, `oktaExternalOidc`, `auth0ExternalOidc`,
 * `keycloakExternalOidc`) which fills in the per-IdP quirks. Use this
 * directly only for an IdP without a preset.
 * At least one non-empty audience, client, or custom-claim binding is
 * required so tokens minted for another application are rejected.
 *
 * Example:
 *   `externalOidc({
 *      issuer: 'https://login.microsoftonline.com/<tenant>/v2.0',
 *      allowedAudience: ['<clientId>'],
 *      customClaim: { name: 'azp', value: '<clientId>' },
 *   })`
 */
export function externalOidc(opts: {
    readonly issuer: string;
    readonly allowedAudience?: string[];
    readonly allowedClients?: string[];
    readonly customClaim?: CustomClaimRule;
    readonly allowedScopes?: string[];
}): ExternalOidcIdentityProvider {
    const issuerUrl = opts.issuer.replace(/\/$/, '');
    const jwtAuthorizer: JwtAuthorizerSpec = {
        discoveryUrl: `${issuerUrl}/.well-known/openid-configuration`,
        issuerUrl,
        ...(opts.allowedAudience !== undefined ? { allowedAudience: opts.allowedAudience } : {}),
        ...(opts.allowedClients !== undefined ? { allowedClients: opts.allowedClients } : {}),
        ...(opts.customClaim !== undefined ? { customClaim: opts.customClaim } : {}),
        ...(opts.allowedScopes !== undefined ? { allowedScopes: opts.allowedScopes } : {}),
    };
    assertJwtAuthorizerBinding(jwtAuthorizer);
    return { kind: 'externalOidc', issuerUrl, jwtAuthorizer };
}

/** Inputs for `importCognito`. */
export interface ImportCognitoOptions {
    /**
     * Existing Cognito user pool ID, e.g. `us-east-1_AbCdEfGhI`.
     * Read from your shared-pool stack outputs (or pasted from the
     * Cognito console).
     */
    readonly userPoolId: string;
    /** Existing app client ID. Must be a public PKCE client (no secret). */
    readonly humanClientId: string;
    /**
     * Hosted UI base URL, e.g.
     * `https://my-org.auth.us-east-1.amazoncognito.com`. Surfaced by
     * `mcp-savvy --print-env` so users know where they'll be sent
     * for sign-in. Cognito doesn't expose this directly via
     * `DescribeUserPool`, so we accept it as input.
     */
    readonly hostedUiUrl: string;
    /**
     * Override the AWS region of the user pool. Defaults to the
     * containing stack's region — set this only when importing a
     * cross-region pool.
     */
    readonly region?: string;
}

/**
 * Reference an existing Cognito user pool you already operate.
 *
 * Example — share one pool across every protected MCP a team ships:
 * ```
 * const idp = importCognito(this, 'SharedAuth', {
 *   userPoolId: 'us-east-1_AbCdEfGhI',
 *   humanClientId: '4l8jhg7d3...',
 *   hostedUiUrl: 'https://my-org.auth.us-east-1.amazoncognito.com',
 * });
 * new AgentCoreRuntime(this, 'Runtime', { identityProvider: idp, ... });
 * ```
 *
 * The returned provider is a structural `CognitoIdentityProvider`,
 * so every existing construct (`AgentCoreRuntime`, `AgentCoreGateway`,
 * future `OAuthCompleteSessionApi`, …) consumes it identically to a
 * pool created via `new CognitoAuth(...)`.
 *
 * The user pool and app client are imported via
 * `cognito.UserPool.fromUserPoolId` /
 * `cognito.UserPoolClient.fromUserPoolClientId`, so they show up in
 * the synthesized template as references rather than newly created
 * resources — `cdk destroy` on a stack consuming the imported pool
 * will not delete the pool itself.
 */
export function importCognito(
    scope: Construct,
    id: string,
    opts: ImportCognitoOptions,
): CognitoIdentityProvider {
    const region = opts.region ?? cdk.Stack.of(scope).region;
    const userPool = cognito.UserPool.fromUserPoolId(scope, `${id}UserPool`, opts.userPoolId);
    const humanClient = cognito.UserPoolClient.fromUserPoolClientId(
        scope,
        `${id}HumanClient`,
        opts.humanClientId,
    );
    const issuerUrl = `https://cognito-idp.${region}.amazonaws.com/${opts.userPoolId}`;
    const jwtAuthorizer: JwtAuthorizerSpec = {
        discoveryUrl: `${issuerUrl}/.well-known/openid-configuration`,
        issuerUrl,
        allowedClients: [opts.humanClientId],
    };
    return {
        kind: 'cognito',
        userPool,
        humanClient,
        issuerUrl,
        hostedUiUrl: opts.hostedUiUrl.replace(/\/$/, ''),
        jwtAuthorizer,
    };
}
