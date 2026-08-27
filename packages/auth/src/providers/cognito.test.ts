/**
 * Unit tests for the Cognito preset.
 */

import { describe, it, expect } from 'vitest';
import { CognitoProvider, cognitoIssuer } from './cognito.js';
import { OidcPkceProvider } from './oidcPkce.js';
import type { Fetcher, FetchResponse } from '../http.js';

const REGION = 'us-east-1';
const POOL = 'us-east-1_AbCdEfGhI';
const EXPECTED_ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${POOL}`;

const COGNITO_DISCOVERY_RESPONSE: FetchResponse = {
    status: 200,
    headers: {},
    body: JSON.stringify({
        authorization_endpoint: `${EXPECTED_ISSUER}/oauth2/authorize`,
        token_endpoint: `${EXPECTED_ISSUER}/oauth2/token`,
        issuer: EXPECTED_ISSUER,
        scopes_supported: ['openid', 'email', 'profile'],
    }),
};

/** Build a Fetcher that captures requests and returns the discovery doc. */
function captureFetcher(): { fetcher: Fetcher; urls: string[] } {
    const urls: string[] = [];
    return {
        fetcher: {
            fetch(req) {
                urls.push(req.url);
                return Promise.resolve(COGNITO_DISCOVERY_RESPONSE);
            },
        },
        urls,
    };
}

describe('cognitoIssuer', () => {
    it('composes the canonical Cognito issuer URL', () => {
        expect(cognitoIssuer(REGION, POOL)).toBe(EXPECTED_ISSUER);
    });
});

describe('CognitoProvider', () => {
    it('is an OidcPkceProvider', () => {
        const p = new CognitoProvider({
            region: REGION,
            userPoolId: POOL,
            clientId: 'c',
            redirectUri: 'http://127.0.0.1/cb',
        });
        expect(p).toBeInstanceOf(OidcPkceProvider);
    });

    it('derives the issuer from region+userPoolId when both are given', async () => {
        const { fetcher, urls } = captureFetcher();
        const p = new CognitoProvider({
            region: REGION,
            userPoolId: POOL,
            clientId: 'c',
            redirectUri: 'http://127.0.0.1/cb',
            fetcher,
        });
        await p.prepareAuthorize();
        expect(urls[0]).toBe(`${EXPECTED_ISSUER}/.well-known/openid-configuration`);
    });

    it('accepts a pre-built issuer when region/userPoolId are absent', async () => {
        const { fetcher, urls } = captureFetcher();
        const p = new CognitoProvider({
            issuer: EXPECTED_ISSUER,
            clientId: 'c',
            redirectUri: 'http://127.0.0.1/cb',
            fetcher,
        });
        await p.prepareAuthorize();
        expect(urls[0]).toBe(`${EXPECTED_ISSUER}/.well-known/openid-configuration`);
    });
});
