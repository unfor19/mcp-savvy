/**
 * RFC 9728 protected-resource metadata for the chatgpt-app-mcp MCP
 * server.
 *
 * MCP hosts (ChatGPT, Claude, the local mcp-savvy bridge) fetch
 * `/.well-known/oauth-protected-resource` to discover the OIDC
 * issuer they should authenticate against, and
 * `/.well-known/oauth-authorization-server` (RFC 8414) for the OAuth
 * endpoints. We serve both on our origin: clients that don't follow
 * the issuer URL still find the AS metadata at the resource origin.
 *
 * `resource` is derived from the request's `Host` header so the
 * same Lambda answers correctly whether the client reaches us via
 * the public API custom-domain URL or a future
 * custom domain. Falls back to `RESOURCE_URL` env var when the
 * env var is set (preferred — CloudFront rewrites Host).
 */

const FALLBACK_RESOURCE_URL = process.env.RESOURCE_URL ?? '';
const AUTH_ISSUER = process.env.OIDC_ISSUER ?? '';
const HOSTED_UI_URL = (process.env.COGNITO_HOSTED_UI_URL ?? '').replace(/\/+$/, '');
const REQUIRED_SCOPES = (process.env.OIDC_REQUIRED_SCOPES ?? '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Build the protected-resource metadata document. */
export function buildProtectedResourceMetadata(headers) {
    const host = pickHostHeader(headers);
    const resource = FALLBACK_RESOURCE_URL || (host ? `https://${host}` : '');
    return {
        resource,
        authorization_servers: AUTH_ISSUER ? [AUTH_ISSUER] : [],
        scopes_supported: REQUIRED_SCOPES,
        bearer_methods_supported: ['header'],
        resource_documentation:
            'https://github.com/mcp-savvy/mcp-savvy/tree/main/examples/chatgpt-app-mcp',
    };
}

/**
 * Build the RFC 8414 Authorization Server Metadata. Values are
 * synthesized from `OIDC_ISSUER` + `COGNITO_HOSTED_UI_URL` so
 * clients that probe `/.well-known/oauth-authorization-server` on
 * our origin (instead of following the issuer redirect to Cognito's
 * own openid-configuration) get a complete document. We add
 * `code_challenge_methods_supported: ['S256']` (Cognito supports
 * PKCE; their openid-configuration omits the field) and include
 * the custom `balance.read` scope.
 */
export function buildAuthorizationServerMetadata() {
    if (!AUTH_ISSUER || !HOSTED_UI_URL) {
        throw new Error('OIDC_ISSUER and COGNITO_HOSTED_UI_URL env vars are required');
    }
    return {
        issuer: AUTH_ISSUER,
        authorization_endpoint: `${HOSTED_UI_URL}/oauth2/authorize`,
        token_endpoint: `${HOSTED_UI_URL}/oauth2/token`,
        userinfo_endpoint: `${HOSTED_UI_URL}/oauth2/userInfo`,
        revocation_endpoint: `${HOSTED_UI_URL}/oauth2/revoke`,
        jwks_uri: `${AUTH_ISSUER}/.well-known/jwks.json`,
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'email', 'profile', ...REQUIRED_SCOPES],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
    };
}

/** Read the request's host header in a case-insensitive way. */
function pickHostHeader(headers) {
    if (!headers || typeof headers !== 'object') return '';
    for (const key of ['x-forwarded-host', 'X-Forwarded-Host', 'host', 'Host']) {
        const value = headers[key];
        if (typeof value === 'string' && value.length > 0) return value;
    }
    return '';
}
