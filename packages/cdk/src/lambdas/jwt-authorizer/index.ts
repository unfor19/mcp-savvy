/**
 * Lambda authorizer for the OAuthCompleteSessionApi REST API.
 *
 * Validates the OIDC JWT (the same token that gates the gateway).
 * Generic across IdPs:
 *   - Cognito: discovery URL, audience = client ID list.
 *   - Microsoft Entra v1 (sts.windows.net) and v2
 *     (login.microsoftonline.com/.../v2.0): both issuer formats are
 *     accepted because Entra can issue either depending on the app
 *     reg's `accessTokenAcceptedVersion` and the requested scope.
 *   - Any other OIDC IdP (Okta, Auth0, Keycloak, …) via the standard
 *     `<issuer>/.well-known/jwks.json` path.
 *
 * Caches the JWKS module-globally so warm invocations don't refetch.
 * API Gateway is configured with a 5-minute results cache so the
 * authorizer itself isn't re-invoked for repeat calls inside the
 * window.
 */

import * as jose from 'jose';

const OIDC_ISSUER = process.env['OIDC_ISSUER'] ?? '';
/** Parse a losslessly serialized string allowlist from the Lambda environment. */
export function parseStringAllowlist(raw: string | undefined, name: string): string[] {
    try {
        const parsed: unknown = JSON.parse(raw ?? '[]');
        if (
            Array.isArray(parsed) &&
            parsed.every((value) => typeof value === 'string' && value.trim().length > 0)
        ) {
            return parsed;
        }
    } catch {
        // The stable configuration error below is safer than accepting a partial allowlist.
    }
    throw new Error(`${name} must be a JSON array of non-empty strings`);
}

const OIDC_ALLOWED_AUDIENCE = parseStringAllowlist(
    process.env['OIDC_ALLOWED_AUDIENCE'],
    'OIDC_ALLOWED_AUDIENCE',
);
const OIDC_ALLOWED_CLIENTS = parseStringAllowlist(
    process.env['OIDC_ALLOWED_CLIENTS'],
    'OIDC_ALLOWED_CLIENTS',
);
const OIDC_ALLOWED_SCOPES = parseStringAllowlist(
    process.env['OIDC_ALLOWED_SCOPES'],
    'OIDC_ALLOWED_SCOPES',
);
// Non-standard client-ID claim binding, for IdPs that don't populate
// `client_id` (Entra v2 → `azp`, Okta → `cid`). Name + value are set
// together by the CDK construct from the IdP's `customClaim`.
const OIDC_CLIENT_CLAIM_NAME = process.env['OIDC_CLIENT_CLAIM_NAME']?.trim() ?? '';
const OIDC_CLIENT_CLAIM_VALUE = process.env['OIDC_CLIENT_CLAIM_VALUE']?.trim() ?? '';

interface AuthorizerEvent {
    type: 'TOKEN';
    authorizationToken: string;
    methodArn: string;
}

interface PolicyDocument {
    readonly Version: '2012-10-17';
    readonly Statement: ReadonlyArray<{
        readonly Action: 'execute-api:Invoke';
        readonly Effect: 'Allow' | 'Deny';
        readonly Resource: string;
    }>;
}

interface AuthorizerResponse {
    readonly principalId: string;
    readonly policyDocument: PolicyDocument;
    readonly context?: Record<string, string>;
}

let jwksCache: jose.JWTVerifyGetKey | null = null;
let jwksCachedFor: string | null = null;

/** Detect Microsoft Entra ID (Azure AD) issuers. */
function isEntraIssuer(issuer: string): boolean {
    return issuer.includes('login.microsoftonline.com') || issuer.includes('sts.windows.net');
}

/** Detect AWS Cognito user-pool issuers across commercial and China partitions. */
function isCognitoIssuer(issuer: string): boolean {
    try {
        return /^cognito-idp\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(
            new URL(issuer).hostname,
        );
    } catch {
        return false;
    }
}

/** Extract the Entra tenant GUID from any of its issuer URL shapes. */
function extractEntraTenant(issuer: string): string | null {
    return issuer.match(/\/([a-f0-9-]{8,})\//)?.[1] ?? null;
}

/**
 * Compose the list of issuer values we'll accept. For Entra we
 * accept both v1 (`sts.windows.net/<tenant>/`) and v2 formats
 * because the IdP picks one based on the app reg manifest's
 * `accessTokenAcceptedVersion`. For everything else we accept the
 * configured issuer both with and without a trailing slash — Auth0
 * signs `iss` WITH the slash (`https://<tenant>/`) while our CDK
 * factory stores the trimmed form, so we tolerate both.
 */
function validIssuers(configured: string): string[] {
    if (isEntraIssuer(configured)) {
        const tenant = extractEntraTenant(configured);
        if (tenant) {
            return [
                `https://login.microsoftonline.com/${tenant}/v2.0`,
                `https://sts.windows.net/${tenant}/`,
            ];
        }
        return [configured];
    }
    const trimmed = configured.replace(/\/$/, '');
    return [trimmed, `${trimmed}/`];
}

/** Resolve the JWKS URI for the issuer. Standard OIDC layout for non-Entra IdPs. */
function jwksUri(issuer: string): string {
    if (isEntraIssuer(issuer)) {
        const tenant = extractEntraTenant(issuer);
        if (tenant) return `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`;
    }
    const trimmed = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
    return `${trimmed}/.well-known/jwks.json`;
}

function getJwks(issuer: string): jose.JWTVerifyGetKey {
    if (jwksCache && jwksCachedFor === issuer) return jwksCache;
    jwksCache = jose.createRemoteJWKSet(new URL(jwksUri(issuer)));
    jwksCachedFor = issuer;
    return jwksCache;
}

interface VerifiedClaims {
    readonly sub: string;
    readonly email: string | undefined;
}

/** Enforce configured client IDs without conflating them with API audiences. */
export function enforceAllowedClients(
    payload: jose.JWTPayload,
    allowedClients: readonly string[],
    issuer: string,
): void {
    if (allowedClients.length === 0) return;

    const clientId = typeof payload['client_id'] === 'string' ? payload['client_id'] : undefined;
    if (clientId !== undefined) {
        if (allowedClients.includes(clientId)) return;
        throw new Error(`client_id claim mismatch: got ${clientId || '<missing>'}`);
    }

    if (isCognitoIssuer(issuer) && payload['token_use'] === 'id') {
        const audiences = Array.isArray(payload.aud)
            ? payload.aud
            : typeof payload.aud === 'string'
                ? [payload.aud]
                : [];
        if (audiences.some((audience) => allowedClients.includes(audience))) return;
        throw new Error('Cognito ID token audience does not match an allowed client');
    }

    throw new Error('JWT missing client_id claim');
}

/** Require at least one exact configured OAuth scope in `scope` or `scp`. */
export function enforceAllowedScopes(
    payload: jose.JWTPayload,
    allowedScopes: readonly string[],
): void {
    if (allowedScopes.length === 0) return;
    const claims = [payload['scope'], payload['scp']];
    const granted = claims.flatMap((claim) =>
        typeof claim === 'string' ? claim.split(/\s+/).filter(Boolean) : [],
    );
    if (!granted.some((scope) => allowedScopes.includes(scope))) {
        throw new Error('JWT does not contain an allowed scope');
    }
}

async function verifyToken(token: string): Promise<VerifiedClaims> {
    const verifyOptions: jose.JWTVerifyOptions = { issuer: validIssuers(OIDC_ISSUER) };
    // `jose.jwtVerify` strictly checks `aud`. Cognito ID tokens bind
    // the app client through `aud`, while Cognito access tokens use
    // `client_id`; only the ID-token shape uses allowedClients as the
    // JWT audience. Every configured control is enforced cumulatively.
    const peeked = peekClaims(token);
    const isCognitoIdToken =
        isCognitoIssuer(OIDC_ISSUER) && peeked.token_use === 'id';
    if (OIDC_ALLOWED_AUDIENCE.length > 0) {
        verifyOptions.audience = OIDC_ALLOWED_AUDIENCE;
    } else if (isCognitoIdToken && OIDC_ALLOWED_CLIENTS.length > 0) {
        verifyOptions.audience = OIDC_ALLOWED_CLIENTS;
    }
    const { payload } = await jose.jwtVerify(token, getJwks(OIDC_ISSUER), verifyOptions);

    enforceAllowedClients(payload, OIDC_ALLOWED_CLIENTS, OIDC_ISSUER);
    enforceAllowedScopes(payload, OIDC_ALLOWED_SCOPES);

    if (OIDC_CLIENT_CLAIM_NAME && OIDC_CLIENT_CLAIM_VALUE) {
        // IdPs that don't carry `client_id` bind the authorizing client
        // to a different claim (Entra v2 → `azp`, Okta → `cid`). We
        // enforce it manually because `jose.jwtVerify` has no option for
        // arbitrary claims, and the same name/value pair is what the
        // upstream AgentCore authorizer's `customClaim` checks.
        const actual =
            typeof payload[OIDC_CLIENT_CLAIM_NAME] === 'string'
                ? (payload[OIDC_CLIENT_CLAIM_NAME] as string)
                : undefined;
        if (actual !== OIDC_CLIENT_CLAIM_VALUE) {
            throw new Error(
                `${OIDC_CLIENT_CLAIM_NAME} claim mismatch: got ${actual ?? '<missing>'}, expected ${OIDC_CLIENT_CLAIM_VALUE}`,
            );
        }
    }

    return {
        sub: typeof payload.sub === 'string' ? payload.sub : '',
        email: typeof payload['email'] === 'string' ? payload['email'] : undefined,
    };
}

/** Decode JWT claims without verifying — only for shape detection. */
function peekClaims(token: string): { aud?: unknown; token_use?: unknown } {
    try {
        return jose.decodeJwt(token);
    } catch {
        return {};
    }
}

function buildPolicy(
    principalId: string,
    effect: 'Allow' | 'Deny',
    resource: string,
    context?: Record<string, string>,
): AuthorizerResponse {
    const response: AuthorizerResponse = {
        principalId,
        policyDocument: {
            Version: '2012-10-17',
            Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resource }],
        },
        ...(context !== undefined ? { context } : {}),
    };
    return response;
}

/** Strip the `Bearer ` scheme prefix per RFC 6750 (case-insensitive). */
function stripBearer(token: string): string {
    return token.replace(/^Bearer\s+/i, '');
}

export const handler = async (event: AuthorizerEvent): Promise<AuthorizerResponse> => {
    const token = stripBearer(event.authorizationToken ?? '');
    if (!token) {
        // API Gateway expects a thrown 'Unauthorized' string for 401 mapping.
        throw new Error('Unauthorized');
    }

    try {
        const claims = await verifyToken(token);
        if (!claims.sub) throw new Error('JWT missing sub claim');
        const context: Record<string, string> = { sub: claims.sub };
        if (claims.email !== undefined) context['email'] = claims.email;
        return buildPolicy(claims.sub, 'Allow', event.methodArn, context);
    } catch (err) {
        // Don't leak validation details to the caller; the API Gateway
        // log group has the full error for operators.
        console.error('JWT validation failed:', err instanceof Error ? err.message : String(err));
        throw new Error('Unauthorized');
    }
};
