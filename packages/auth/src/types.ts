/**
 * Public types for the auth layer.
 */

import type { TokenData } from '@mcp-savvy/core';

/**
 * Outcome of `prepareAuthorize`: everything the server layer needs
 * to (a) open the user's browser at `authorizeUrl` and (b) exchange
 * the auth code once the IdP redirects back.
 */
export interface AuthorizePrep {
    /** URL to open in the user's browser. */
    authorizeUrl: string;
    /** PKCE verifier the token-exchange call will need. */
    codeVerifier: string;
    /** CSRF protection: caller must verify the IdP echoes this back. */
    state: string;
    /** Loopback URL the IdP will redirect to. Mirrors what was sent in the URL. */
    redirectUri: string;
}

/**
 * Inputs for `exchangeCode`. The caller has captured `code` and
 * `state` from the IdP's redirect to the local callback server.
 */
export interface ExchangeCodeInput {
    /** Authorization code received from the IdP. */
    code: string;
    /** State value the IdP echoed back (must match `prepareAuthorize`). */
    state: string;
    /** PKCE verifier from `prepareAuthorize`. */
    codeVerifier: string;
    /** Redirect URI used in `prepareAuthorize` — IdPs require it to match. */
    redirectUri: string;
}

/**
 * Auth provider interface. Implementations encapsulate one IdP's
 * specifics (Cognito, Entra, generic OIDC) but expose the same
 * three methods to the bridge layer.
 */
export interface AuthProvider {
    /** Build the authorize URL + PKCE state for a fresh sign-in. */
    prepareAuthorize(): Promise<AuthorizePrep>;
    /** Trade an auth code for tokens. */
    exchangeCode(input: ExchangeCodeInput): Promise<TokenData>;
    /** Use a refresh_token to get fresh tokens. */
    refresh(refreshToken: string): Promise<TokenData>;
}
