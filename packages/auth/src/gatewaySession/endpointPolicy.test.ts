/** Regression tests for second-leg credential endpoint policy. */

import { describe, expect, it, vi } from 'vitest';
import type { Fetcher } from '../http.js';
import { completeGatewaySession } from './index.js';

const SESSION_URI = 'urn:ietf:params:oauth:request_uri:session-test';
const AUTHORIZATION_URL =
    `https://idp.example.com/authorize?request_uri=${encodeURIComponent(SESSION_URI)}`;

function neverFetcher(): Fetcher {
    return {
        fetch: vi.fn(() => Promise.reject(new Error('fetch must not run'))),
    };
}

describe('completeGatewaySession endpoint policy', () => {
    it('rejects a plaintext remote completion endpoint before opening the browser', async () => {
        const openBrowser = vi.fn<() => Promise<void>>();
        await expect(completeGatewaySession({
            authorizationUrl: AUTHORIZATION_URL,
            completeSessionEndpoint: 'http://api.example.com/complete',
            userToken: 'user-token',
            openBrowser,
            fetcher: neverFetcher(),
        })).rejects.toThrow(/must use HTTPS/);
        expect(openBrowser).not.toHaveBeenCalled();
    });

    it('rejects a plaintext remote authorization URL before opening the browser', async () => {
        const openBrowser = vi.fn<() => Promise<void>>();
        await expect(completeGatewaySession({
            authorizationUrl: AUTHORIZATION_URL.replace('https://', 'http://'),
            completeSessionEndpoint: 'https://api.example.com/complete',
            userToken: 'user-token',
            openBrowser,
            fetcher: neverFetcher(),
        })).rejects.toThrow(/authorization URL must use HTTPS/);
        expect(openBrowser).not.toHaveBeenCalled();
    });
});
