/**
 * Test-only fixtures and helpers shared across `auth` test files.
 *
 * This module is in `src/` so it gets type-checked, but it's excluded
 * from the published package (only `*.test.ts` adjacent to the source
 * imports it; nothing in the public API touches it).
 */

import { expect } from 'vitest';
import type { Fetcher, FetchRequest, FetchResponse } from './http.js';

/** A canonical OIDC discovery doc used by provider tests. */
export const FIXTURE_DISCOVERY = {
    authorization_endpoint: 'https://idp.example.com/authorize',
    token_endpoint: 'https://idp.example.com/token',
    issuer: 'https://idp.example.com',
    scopes_supported: ['openid', 'email', 'profile'],
};

/** Pre-built OK response with the canonical discovery doc body. */
export const FIXTURE_DISCOVERY_RESPONSE: FetchResponse = {
    status: 200,
    headers: {},
    body: JSON.stringify(FIXTURE_DISCOVERY),
};

/** One scripted call: which URL to expect and what to return. */
export interface ScriptedCall {
    matchUrl: string | RegExp;
    response: FetchResponse;
}

/** Result of `scriptedFetcher`: the fetcher and the captured call list. */
export interface ScriptedFetcher {
    fetcher: Fetcher;
    captured: FetchRequest[];
}

/** Build a Fetcher that records every call and returns scripted responses. */
export function scriptedFetcher(calls: ScriptedCall[]): ScriptedFetcher {
    const captured: FetchRequest[] = [];
    let i = 0;
    return {
        fetcher: {
            fetch(req) {
                captured.push(req);
                const next = calls[i++];
                if (!next) throw new Error(`unexpected fetch call: ${req.method} ${req.url}`);
                if (typeof next.matchUrl === 'string') {
                    expect(req.url).toBe(next.matchUrl);
                } else {
                    expect(req.url).toMatch(next.matchUrl);
                }
                return Promise.resolve(next.response);
            },
        },
        captured,
    };
}
