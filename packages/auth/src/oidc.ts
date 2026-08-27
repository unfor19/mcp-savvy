/**
 * OIDC discovery helpers (`/.well-known/openid-configuration`).
 */

import type { OIDCEndpoints } from '@mcp-savvy/core';
import { AuthError } from '@mcp-savvy/core';
import type { Fetcher } from './http.js';

/** Discovery document subset we care about. */
export interface OIDCDiscoveryDocument {
    authorization_endpoint?: string;
    token_endpoint?: string;
    issuer?: string;
    scopes_supported?: string[];
}

/** Build the `.well-known/openid-configuration` URL for an issuer. */
export function discoveryUrl(issuer: string): string {
    return issuer.replace(/\/$/, '') + '/.well-known/openid-configuration';
}

/**
 * Fetch and validate the issuer's OIDC discovery document. Throws
 * `AuthError(OIDC_DISCOVERY_FAILED)` on any non-200 or missing
 * required field.
 */
export async function fetchOIDC(issuer: string, fetcher: Fetcher): Promise<OIDCEndpoints> {
    const url = discoveryUrl(issuer);
    const res = await fetcher.fetch({ method: 'GET', url });
    if (res.status !== 200) {
        throw new AuthError(
            'OIDC_DISCOVERY_FAILED',
            `OIDC discovery returned status ${res.status} for ${url}`,
        );
    }
    let doc: OIDCDiscoveryDocument;
    try {
        doc = JSON.parse(res.body) as OIDCDiscoveryDocument;
    } catch (cause) {
        throw new AuthError(
            'OIDC_DISCOVERY_FAILED',
            `OIDC discovery body is not valid JSON (${url})`,
            cause,
        );
    }
    if (!doc.authorization_endpoint || !doc.token_endpoint) {
        throw new AuthError(
            'OIDC_DISCOVERY_FAILED',
            `OIDC discovery doc missing required endpoints (${url})`,
        );
    }
    const result: OIDCEndpoints = {
        authorization_endpoint: doc.authorization_endpoint,
        token_endpoint: doc.token_endpoint,
        issuer: doc.issuer ?? issuer,
    };
    if (doc.scopes_supported) result.scopes_supported = doc.scopes_supported;
    return result;
}

/**
 * Standard OIDC scopes per spec — these are the ones an IdP is
 * expected to advertise in `scopes_supported`. Resource scopes
 * (e.g. Entra's `<clientId>/.default`, Microsoft Graph's `User.Read`,
 * Auth0's `read:posts`) are application-specific and are NOT expected
 * to appear in discovery, so they pass through filtering unchanged.
 */
const STANDARD_OIDC_SCOPES = new Set([
    'openid',
    'email',
    'profile',
    'offline_access',
    'address',
    'phone',
]);

/**
 * Filter a space-separated scope string against the IdP's
 * `scopes_supported`. Only filters STANDARD OIDC scopes
 * (openid/email/profile/offline_access/address/phone); any custom or
 * resource scopes (e.g. `<guid>/.default`, `User.Read`, `read:posts`)
 * pass through unchanged because IdPs don't advertise them in
 * discovery even when they accept them.
 *
 * If the IdP doesn't publish `scopes_supported`, return the requested
 * scopes unchanged.
 *
 * `openid` is always preserved so we don't accidentally request a
 * non-OIDC flow.
 */
export function filterScopes(requested: string, supported?: string[]): string {
    if (!supported) return requested;
    const supportedSet = new Set(supported);
    const requestedList = requested.split(/\s+/).filter((s) => s.length > 0);
    const filtered = requestedList.filter((s) => {
        if (STANDARD_OIDC_SCOPES.has(s)) return supportedSet.has(s);
        return true;
    });
    if (!filtered.includes('openid') && supportedSet.has('openid')) {
        filtered.unshift('openid');
    }
    return filtered.join(' ');
}
