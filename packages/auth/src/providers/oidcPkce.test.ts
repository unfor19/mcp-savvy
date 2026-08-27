/**
 * Unit tests for the generic `OidcPkceProvider`. We inject a fake
 * `Fetcher` so no real HTTP calls are made.
 */

import { describe, it, expect } from 'vitest';
import { AuthError } from '@mcp-savvy/core';
import { OidcPkceProvider } from './oidcPkce.js';
import {
    FIXTURE_DISCOVERY,
    FIXTURE_DISCOVERY_RESPONSE,
    scriptedFetcher,
} from '../testFixtures.js';

const ISSUER = FIXTURE_DISCOVERY.issuer;
const CLIENT_ID = 'client-abc';
const REDIRECT_URI = 'http://localhost:33423/callback';

describe('prepareAuthorize', () => {
    it('builds an authorize URL with PKCE + state and filtered scopes', async () => {
        const { fetcher } = scriptedFetcher([
            {
                matchUrl: 'https://idp.example.com/.well-known/openid-configuration',
                response: FIXTURE_DISCOVERY_RESPONSE,
            },
        ]);
        const provider = new OidcPkceProvider({
            issuer: ISSUER,
            clientId: CLIENT_ID,
            redirectUri: REDIRECT_URI,
            scopes: 'openid email phone custom-resource',
            fetcher,
        });
        const prep = await provider.prepareAuthorize();
        expect(prep.redirectUri).toBe(REDIRECT_URI);
        expect(prep.codeVerifier.length).toBeGreaterThan(40);
        expect(prep.state.length).toBeGreaterThan(0);
        const url = new URL(prep.authorizeUrl);
        expect(url.origin + url.pathname).toBe(FIXTURE_DISCOVERY.authorization_endpoint);
        expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
        expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.get('state')).toBe(prep.state);
        // 'phone' is a standard OIDC scope NOT in scopes_supported -> dropped.
        // 'custom-resource' is a non-standard scope -> passes through (Entra
        // and other IdPs accept resource scopes that aren't advertised).
        expect(url.searchParams.get('scope')).toBe('openid email custom-resource');
    });

    it('caches the discovery document across calls', async () => {
        const { fetcher, captured } = scriptedFetcher([
            { matchUrl: /openid-configuration$/, response: FIXTURE_DISCOVERY_RESPONSE },
        ]);
        const provider = new OidcPkceProvider({
            issuer: ISSUER,
            clientId: CLIENT_ID,
            redirectUri: REDIRECT_URI,
            fetcher,
        });
        await provider.prepareAuthorize();
        await provider.prepareAuthorize();
        const discoveryCalls = captured.filter((c) => c.url.includes('openid-configuration'));
        expect(discoveryCalls).toHaveLength(1);
    });

    it('uses the default scope set when none is supplied', async () => {
        const { fetcher } = scriptedFetcher([
            { matchUrl: /./, response: FIXTURE_DISCOVERY_RESPONSE },
        ]);
        const provider = new OidcPkceProvider({
            issuer: ISSUER,
            clientId: CLIENT_ID,
            redirectUri: REDIRECT_URI,
            fetcher,
        });
        const prep = await provider.prepareAuthorize();
        expect(new URL(prep.authorizeUrl).searchParams.get('scope')).toBe(
            'openid email profile',
        );
    });
});

describe('exchangeCode', () => {
    it('POSTs the auth code with PKCE verifier and parses the token response', async () => {
        const { fetcher, captured } = scriptedFetcher([
            { matchUrl: /openid-configuration$/, response: FIXTURE_DISCOVERY_RESPONSE },
            {
                matchUrl: FIXTURE_DISCOVERY.token_endpoint,
                response: {
                    status: 200,
                    headers: {},
                    body: JSON.stringify({
                        access_token: 'a',
                        refresh_token: 'r',
                        id_token: 'i',
                        expires_in: 3600,
                    }),
                },
            },
        ]);
        const provider = new OidcPkceProvider({
            issuer: ISSUER,
            clientId: CLIENT_ID,
            redirectUri: REDIRECT_URI,
            fetcher,
        });
        const tokens = await provider.exchangeCode({
            code: 'authcode',
            state: 'st',
            codeVerifier: 'verifier',
            redirectUri: REDIRECT_URI,
        });
        expect(tokens.access_token).toBe('a');
        expect(tokens.refresh_token).toBe('r');
        expect(tokens.id_token).toBe('i');
        expect(tokens.expires_at).toBeGreaterThan(Date.now());
        const tokenCall = captured[1]!;
        expect(tokenCall.method).toBe('POST');
        expect(tokenCall.body).toContain('grant_type=authorization_code');
        expect(tokenCall.body).toContain('code=authcode');
        expect(tokenCall.body).toContain('code_verifier=verifier');
    });

    it('throws TOKEN_EXCHANGE_FAILED on non-200', async () => {
        const { fetcher } = scriptedFetcher([
            { matchUrl: /openid-configuration$/, response: FIXTURE_DISCOVERY_RESPONSE },
            {
                matchUrl: FIXTURE_DISCOVERY.token_endpoint,
                response: { status: 400, headers: {}, body: 'invalid_grant' },
            },
        ]);
        const provider = new OidcPkceProvider({
            issuer: ISSUER,
            clientId: CLIENT_ID,
            redirectUri: REDIRECT_URI,
            fetcher,
        });
        const operation = provider.exchangeCode({
            code: 'x',
            state: 's',
            codeVerifier: 'v',
            redirectUri: REDIRECT_URI,
        });
        await expect(operation).rejects.toMatchObject({ code: 'TOKEN_EXCHANGE_FAILED' });
        await expect(operation).rejects.not.toThrow('invalid_grant');
    });

    it('throws on invalid JSON in the token response', async () => {
        const { fetcher } = scriptedFetcher([
            { matchUrl: /openid-configuration$/, response: FIXTURE_DISCOVERY_RESPONSE },
            {
                matchUrl: FIXTURE_DISCOVERY.token_endpoint,
                response: { status: 200, headers: {}, body: '{nope' },
            },
        ]);
        const provider = new OidcPkceProvider({
            issuer: ISSUER,
            clientId: CLIENT_ID,
            redirectUri: REDIRECT_URI,
            fetcher,
        });
        await expect(
            provider.exchangeCode({
                code: 'x',
                state: 's',
                codeVerifier: 'v',
                redirectUri: REDIRECT_URI,
            }),
        ).rejects.toBeInstanceOf(AuthError);
    });

    it('throws when access_token is missing', async () => {
        const { fetcher } = scriptedFetcher([
            { matchUrl: /openid-configuration$/, response: FIXTURE_DISCOVERY_RESPONSE },
            {
                matchUrl: FIXTURE_DISCOVERY.token_endpoint,
                response: { status: 200, headers: {}, body: JSON.stringify({ id_token: 'i' }) },
            },
        ]);
        const provider = new OidcPkceProvider({
            issuer: ISSUER,
            clientId: CLIENT_ID,
            redirectUri: REDIRECT_URI,
            fetcher,
        });
        await expect(
            provider.exchangeCode({
                code: 'x',
                state: 's',
                codeVerifier: 'v',
                redirectUri: REDIRECT_URI,
            }),
        ).rejects.toMatchObject({ code: 'TOKEN_EXCHANGE_FAILED' });
    });

    it('defaults expires_in to 3600 when missing', async () => {
        const { fetcher } = scriptedFetcher([
            { matchUrl: /openid-configuration$/, response: FIXTURE_DISCOVERY_RESPONSE },
            {
                matchUrl: FIXTURE_DISCOVERY.token_endpoint,
                response: {
                    status: 200,
                    headers: {},
                    body: JSON.stringify({ access_token: 'a' }),
                },
            },
        ]);
        const provider = new OidcPkceProvider({
            issuer: ISSUER,
            clientId: CLIENT_ID,
            redirectUri: REDIRECT_URI,
            fetcher,
        });
        const before = Date.now();
        const tokens = await provider.exchangeCode({
            code: 'x',
            state: 's',
            codeVerifier: 'v',
            redirectUri: REDIRECT_URI,
        });
        const after = Date.now();
        expect(tokens.expires_at).toBeGreaterThanOrEqual(before + 3600 * 1000);
        expect(tokens.expires_at).toBeLessThanOrEqual(after + 3600 * 1000);
    });
});

describe('refresh', () => {
    it('POSTs grant_type=refresh_token and parses the response', async () => {
        const { fetcher, captured } = scriptedFetcher([
            { matchUrl: /openid-configuration$/, response: FIXTURE_DISCOVERY_RESPONSE },
            {
                matchUrl: FIXTURE_DISCOVERY.token_endpoint,
                response: {
                    status: 200,
                    headers: {},
                    body: JSON.stringify({ access_token: 'a2', expires_in: 3600 }),
                },
            },
        ]);
        const provider = new OidcPkceProvider({
            issuer: ISSUER,
            clientId: CLIENT_ID,
            redirectUri: REDIRECT_URI,
            fetcher,
        });
        const tokens = await provider.refresh('old-refresh');
        expect(tokens.access_token).toBe('a2');
        // Cognito-style: server omitted refresh_token, we preserve the prior one.
        expect(tokens.refresh_token).toBe('old-refresh');
        expect(captured[1]?.body).toContain('grant_type=refresh_token');
        expect(captured[1]?.body).toContain('refresh_token=old-refresh');
    });

    it('uses the new refresh_token when the IdP rotates it', async () => {
        const { fetcher } = scriptedFetcher([
            { matchUrl: /openid-configuration$/, response: FIXTURE_DISCOVERY_RESPONSE },
            {
                matchUrl: FIXTURE_DISCOVERY.token_endpoint,
                response: {
                    status: 200,
                    headers: {},
                    body: JSON.stringify({
                        access_token: 'a2',
                        refresh_token: 'rotated',
                        expires_in: 3600,
                    }),
                },
            },
        ]);
        const provider = new OidcPkceProvider({
            issuer: ISSUER,
            clientId: CLIENT_ID,
            redirectUri: REDIRECT_URI,
            fetcher,
        });
        const tokens = await provider.refresh('old-refresh');
        expect(tokens.refresh_token).toBe('rotated');
    });

    it('throws TOKEN_REFRESH_FAILED on non-200', async () => {
        const { fetcher } = scriptedFetcher([
            { matchUrl: /openid-configuration$/, response: FIXTURE_DISCOVERY_RESPONSE },
            {
                matchUrl: FIXTURE_DISCOVERY.token_endpoint,
                response: { status: 400, headers: {}, body: 'invalid_grant' },
            },
        ]);
        const provider = new OidcPkceProvider({
            issuer: ISSUER,
            clientId: CLIENT_ID,
            redirectUri: REDIRECT_URI,
            fetcher,
        });
        const operation = provider.refresh('r');
        await expect(operation).rejects.toMatchObject({ code: 'TOKEN_REFRESH_FAILED' });
        await expect(operation).rejects.not.toThrow('invalid_grant');
    });
});
