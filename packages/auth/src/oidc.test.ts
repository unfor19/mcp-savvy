/**
 * Unit tests for OIDC discovery helpers.
 */

import { describe, it, expect } from 'vitest';
import { AuthError } from '@mcp-savvy/core';
import { discoveryUrl, fetchOIDC, filterScopes } from './oidc.js';
import type { Fetcher, FetchResponse } from './http.js';

const ISSUER = 'https://example.com/oidc';
const VALID_DOC = {
    authorization_endpoint: 'https://example.com/oidc/authorize',
    token_endpoint: 'https://example.com/oidc/token',
    issuer: ISSUER,
    scopes_supported: ['openid', 'email', 'profile'],
};

/** Build a single-shot Fetcher that returns a fixed response. */
function fakeFetcher(res: FetchResponse): Fetcher {
    return { fetch: () => Promise.resolve(res) };
}

describe('discoveryUrl', () => {
    it('appends the well-known suffix', () => {
        expect(discoveryUrl('https://x/oidc')).toBe(
            'https://x/oidc/.well-known/openid-configuration',
        );
    });

    it('strips a single trailing slash', () => {
        expect(discoveryUrl('https://x/oidc/')).toBe(
            'https://x/oidc/.well-known/openid-configuration',
        );
    });
});

describe('fetchOIDC', () => {
    it('parses a valid discovery document', async () => {
        const fetcher = fakeFetcher({ status: 200, headers: {}, body: JSON.stringify(VALID_DOC) });
        const ep = await fetchOIDC(ISSUER, fetcher);
        expect(ep.authorization_endpoint).toBe(VALID_DOC.authorization_endpoint);
        expect(ep.token_endpoint).toBe(VALID_DOC.token_endpoint);
        expect(ep.scopes_supported).toEqual(VALID_DOC.scopes_supported);
    });

    it('rejects a discovery document that omits its issuer', async () => {
        const partial = { ...VALID_DOC } as Record<string, unknown>;
        delete partial['issuer'];
        const fetcher = fakeFetcher({ status: 200, headers: {}, body: JSON.stringify(partial) });
        await expect(fetchOIDC(ISSUER, fetcher)).rejects.toMatchObject({
            code: 'OIDC_DISCOVERY_FAILED',
        });
    });

    it('rejects mismatched issuers and plaintext discovered endpoints', async () => {
        const mismatch = fakeFetcher({
            status: 200,
            headers: {},
            body: JSON.stringify({ ...VALID_DOC, issuer: 'https://other.example.com' }),
        });
        await expect(fetchOIDC(ISSUER, mismatch)).rejects.toThrow(/issuer mismatch/);

        const plaintext = fakeFetcher({
            status: 200,
            headers: {},
            body: JSON.stringify({ ...VALID_DOC, token_endpoint: 'http://example.com/token' }),
        });
        await expect(fetchOIDC(ISSUER, plaintext)).rejects.toThrow(/must use HTTPS/);

        const loopbackDowngrade = fakeFetcher({
            status: 200,
            headers: {},
            body: JSON.stringify({ ...VALID_DOC, token_endpoint: 'http://127.0.0.1/token' }),
        });
        await expect(fetchOIDC(ISSUER, loopbackDowngrade)).rejects.toThrow(/must use HTTPS/);
    });

    it('permits exact loopback HTTP discovery for local development', async () => {
        const issuer = 'http://127.0.0.1:8080';
        const fetcher = fakeFetcher({
            status: 200,
            headers: {},
            body: JSON.stringify({
                issuer,
                authorization_endpoint: `${issuer}/authorize`,
                token_endpoint: `${issuer}/token`,
            }),
        });
        await expect(fetchOIDC(issuer, fetcher)).resolves.toMatchObject({ issuer });
    });

    it('throws OIDC_DISCOVERY_FAILED on non-200', async () => {
        const fetcher = fakeFetcher({ status: 404, headers: {}, body: 'not found' });
        await expect(fetchOIDC(ISSUER, fetcher)).rejects.toMatchObject({
            code: 'OIDC_DISCOVERY_FAILED',
        });
    });

    it('throws on invalid JSON', async () => {
        const fetcher = fakeFetcher({ status: 200, headers: {}, body: '{not json' });
        await expect(fetchOIDC(ISSUER, fetcher)).rejects.toBeInstanceOf(AuthError);
    });

    it('throws when required endpoints are missing', async () => {
        const partial = { ...VALID_DOC } as Record<string, unknown>;
        delete partial['authorization_endpoint'];
        const fetcher = fakeFetcher({ status: 200, headers: {}, body: JSON.stringify(partial) });
        await expect(fetchOIDC(ISSUER, fetcher)).rejects.toMatchObject({
            code: 'OIDC_DISCOVERY_FAILED',
        });
    });
});

describe('filterScopes', () => {
    it('returns the original string when scopes_supported is absent', () => {
        expect(filterScopes('openid email custom')).toBe('openid email custom');
    });

    it('drops standard OIDC scopes the IdP does not advertise', () => {
        expect(filterScopes('openid email phone', ['openid', 'email'])).toBe('openid email');
    });

    it('passes resource scopes through unchanged even when not advertised', () => {
        // Entra ID / Microsoft Graph / Auth0 / etc. don't advertise resource
        // scopes in discovery, but they accept them at the wire. Custom
        // scopes like `<guid>/.default`, `User.Read`, `read:posts` must
        // pass through, otherwise no MCP backend gets a usable audience.
        expect(
            filterScopes(
                'openid email 11111111-1111-1111-1111-111111111111/.default',
                ['openid', 'email', 'profile', 'offline_access'],
            ),
        ).toBe('openid email 11111111-1111-1111-1111-111111111111/.default');
    });

    it('preserves openid even if dropped from the list', () => {
        expect(filterScopes('email profile', ['openid', 'email', 'profile'])).toBe(
            'openid email profile',
        );
    });

    it('does not add openid if the IdP does not support it', () => {
        expect(filterScopes('email', ['email'])).toBe('email');
    });

    it('handles extra whitespace gracefully', () => {
        expect(filterScopes('  openid   email  ', ['openid', 'email'])).toBe('openid email');
    });
});
