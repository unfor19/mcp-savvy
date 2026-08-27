/**
 * Shared types for mcp-savvy.
 */

/**
 * OAuth/OIDC token bundle as cached on disk or in keychain.
 *
 * `expires_at` is an absolute epoch in milliseconds (Date.now() compatible).
 * The Python clients use seconds; the TS packages use ms — we standardize
 * on ms here and convert at the Python boundary later.
 */
export interface TokenData {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    /** Absolute expiry as epoch milliseconds. */
    expires_at: number;
}

/**
 * Endpoints discovered from `/.well-known/openid-configuration`.
 */
export interface OIDCEndpoints {
    authorization_endpoint: string;
    token_endpoint: string;
    issuer: string;
    scopes_supported?: string[];
}

/**
 * Hook used by every code path that needs to open the user's browser
 * (first-leg PKCE + second-leg 3LO). Centralized here so the auth and
 * CLI packages share one signature; the CLI's default implementation
 * shells out to `open`/`xdg-open`/`start`.
 */
export type AuthorizeBrowser = (url: string) => void | Promise<void>;
