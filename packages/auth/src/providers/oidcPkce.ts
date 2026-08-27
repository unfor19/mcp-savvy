/**
 * Generic OIDC PKCE provider. Works with any OIDC-compliant IdP
 * (Cognito, Entra, Auth0, Okta, Keycloak, etc.).
 */

import type { OIDCEndpoints, TokenData } from '@mcp-savvy/core';
import { AuthError } from '@mcp-savvy/core';
import { fetchOIDC, filterScopes } from '../oidc.js';
import { generatePkce, generateState } from '../pkce.js';
import { nodeFetcher, type Fetcher } from '../http.js';
import type {
    AuthorizePrep,
    AuthProvider,
    ExchangeCodeInput,
} from '../types.js';

/** Options for `OidcPkceProvider`. */
export interface OidcPkceProviderOptions {
    /** OIDC issuer URL (everything before `/.well-known/openid-configuration`). */
    issuer: string;
    /** OIDC client ID (must be a public client; PKCE is unauthenticated). */
    clientId: string;
    /** Redirect URI registered with the IdP; e.g. `http://localhost:33423/callback`. */
    redirectUri: string;
    /** Space-separated scopes; default: 'openid email profile'. */
    scopes?: string;
    /** Override the HTTP client (tests pass a fake; prod leaves unset). */
    fetcher?: Fetcher;
}

const DEFAULT_SCOPES = 'openid email profile';

/**
 * Generic OIDC + PKCE provider. Caches the discovery document on
 * first use; callers don't have to await discovery separately.
 */
export class OidcPkceProvider implements AuthProvider {
    protected readonly issuer: string;
    protected readonly clientId: string;
    protected readonly redirectUri: string;
    protected readonly scopes: string;
    protected readonly fetcher: Fetcher;
    private endpointsPromise?: Promise<OIDCEndpoints>;

    constructor(opts: OidcPkceProviderOptions) {
        this.issuer = opts.issuer;
        this.clientId = opts.clientId;
        this.redirectUri = opts.redirectUri;
        this.scopes = opts.scopes ?? DEFAULT_SCOPES;
        this.fetcher = opts.fetcher ?? nodeFetcher;
    }

    /** Lazily fetch and cache the OIDC discovery document. */
    protected async endpoints(): Promise<OIDCEndpoints> {
        if (!this.endpointsPromise) {
            this.endpointsPromise = fetchOIDC(this.issuer, this.fetcher);
        }
        return this.endpointsPromise;
    }

    /** Build the authorize URL with PKCE + state. */
    async prepareAuthorize(): Promise<AuthorizePrep> {
        const ep = await this.endpoints();
        const pkce = generatePkce();
        const state = generateState();
        const scopes = filterScopes(this.scopes, ep.scopes_supported);
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: this.clientId,
            redirect_uri: this.redirectUri,
            scope: scopes,
            state,
            code_challenge: pkce.codeChallenge,
            code_challenge_method: pkce.codeChallengeMethod,
        });
        return {
            authorizeUrl: `${ep.authorization_endpoint}?${params.toString()}`,
            codeVerifier: pkce.codeVerifier,
            state,
            redirectUri: this.redirectUri,
        };
    }

    /** Trade an auth code for tokens. */
    async exchangeCode(input: ExchangeCodeInput): Promise<TokenData> {
        const ep = await this.endpoints();
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: this.clientId,
            code: input.code,
            redirect_uri: input.redirectUri,
            code_verifier: input.codeVerifier,
        }).toString();
        const res = await this.fetcher.fetch({
            method: 'POST',
            url: ep.token_endpoint,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
        });
        if (res.status !== 200) {
            throw new AuthError(
                'TOKEN_EXCHANGE_FAILED',
                `token exchange returned HTTP ${res.status}`,
            );
        }
        return parseTokenResponse(res.body);
    }

    /** Use a refresh token to mint fresh tokens. */
    async refresh(refreshToken: string): Promise<TokenData> {
        const ep = await this.endpoints();
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: this.clientId,
            refresh_token: refreshToken,
        }).toString();
        const res = await this.fetcher.fetch({
            method: 'POST',
            url: ep.token_endpoint,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
        });
        if (res.status !== 200) {
            throw new AuthError(
                'TOKEN_REFRESH_FAILED',
                `refresh returned HTTP ${res.status}`,
            );
        }
        const tokens = parseTokenResponse(res.body);
        // Some IdPs (notably Cognito) don't return a fresh refresh_token
        // on a refresh grant — preserve the prior one so the session
        // doesn't end early.
        if (!tokens.refresh_token) tokens.refresh_token = refreshToken;
        return tokens;
    }
}

/** Parse the token endpoint's JSON response into a `TokenData`. */
function parseTokenResponse(body: string): TokenData {
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(body) as Record<string, unknown>;
    } catch (cause) {
        throw new AuthError('TOKEN_EXCHANGE_FAILED', 'token endpoint returned non-JSON', cause);
    }
    const accessToken = parsed['access_token'];
    if (typeof accessToken !== 'string') {
        throw new AuthError('TOKEN_EXCHANGE_FAILED', 'token response missing access_token');
    }
    const expiresIn = typeof parsed['expires_in'] === 'number' ? parsed['expires_in'] : 3600;
    const result: TokenData = {
        access_token: accessToken,
        expires_at: Date.now() + expiresIn * 1000,
    };
    if (typeof parsed['refresh_token'] === 'string') {
        result.refresh_token = parsed['refresh_token'];
    }
    if (typeof parsed['id_token'] === 'string') {
        result.id_token = parsed['id_token'];
    }
    return result;
}
