/**
 * Unit and property-based tests for `TokenManager`. The property
 * tests exercise the cross-process lock by giving each manager its
 * own `LockCoordinator` instance, all pointed at the same on-disk
 * `dataDir` so the lock file serializes them like sibling processes.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { LockCoordinator } from '@mcp-savvy/storage';
import { TokenManager } from './manager.js';
import {
    tokenData,
    memoryStore,
    scriptedAuth,
    fakeCallbackServer,
    fakeLogger,
} from '../testFixtures.js';

describe('cached path', () => {
    it('returns the cached access_token when fresh', async () => {
        const store = memoryStore(tokenData({ access_token: 'cached' }));
        const auth = scriptedAuth();
        const cb = fakeCallbackServer({ result: { code: 'unused', state: 's' } });
        const tm = new TokenManager({
            auth,
            store,
            createCallbackServer: () => cb.server,
        });
        const out = await tm.getAccessToken({ forceRefresh: false });
        expect(out).toBe('cached');
        expect(auth.calls).toEqual([]);
        expect(cb.listenCalls).toBe(0);
    });

    it('skips the cache and refreshes when forceRefresh=true', async () => {
        const store = memoryStore(tokenData({ access_token: 'cached', refresh_token: 'r-old' }));
        const auth = scriptedAuth({
            refresh: async () => tokenData({ access_token: 'fresh', refresh_token: 'r-new' }),
        });
        const cb = fakeCallbackServer({ result: { code: 'unused', state: 's' } });
        const tm = new TokenManager({
            auth,
            store,
            createCallbackServer: () => cb.server,
        });
        const out = await tm.getAccessToken({ forceRefresh: true });
        expect(out).toBe('fresh');
        expect(auth.calls.map((c) => c.method)).toEqual(['refresh']);
        expect(store.inspect()?.refresh_token).toBe('r-new');
    });

    it('treats tokens within the refresh buffer as stale', async () => {
        // 30 seconds left — under the 60s buffer.
        const store = memoryStore(tokenData({ expires_at: Date.now() + 30_000 }));
        const auth = scriptedAuth({
            refresh: async () => tokenData({ access_token: 'fresh' }),
        });
        const cb = fakeCallbackServer({ result: { code: 'unused', state: 's' } });
        const tm = new TokenManager({
            auth,
            store,
            createCallbackServer: () => cb.server,
        });
        const out = await tm.getAccessToken({ forceRefresh: false });
        expect(out).toBe('fresh');
    });
});

describe('refresh path', () => {
    it('falls back to PKCE when refresh fails', async () => {
        const store = memoryStore(tokenData({ expires_at: Date.now() - 1, refresh_token: 'r' }));
        const opens: string[] = [];
        const auth = scriptedAuth({
            refresh: async () => {
                throw new Error('refresh denied');
            },
            prepareAuthorize: async () => ({
                authorizeUrl: 'https://idp.example/auth?state=state-sensitive',
                codeVerifier: 'v',
                state: 's',
                redirectUri: 'http://localhost:33423/callback',
            }),
            exchangeCode: async () => tokenData({ access_token: 'pkce-fresh' }),
        });
        const cb = fakeCallbackServer({ result: { code: 'authcode', state: 's' } });
        const logger = fakeLogger();
        const tm = new TokenManager({
            auth,
            store,
            createCallbackServer: () => cb.server,
            openBrowser: async (url) => { opens.push(url); },
            logger,
        });
        const out = await tm.getAccessToken({ forceRefresh: false });
        expect(out).toBe('pkce-fresh');
        expect(opens).toEqual(['https://idp.example/auth?state=state-sensitive']);
        expect(JSON.stringify(logger.records)).not.toContain('state-sensitive');
        expect(cb.listenCalls).toBe(1);
        expect(cb.stopCalls).toBe(1);
    });

    it('runs PKCE when nothing is cached', async () => {
        const store = memoryStore(null);
        const auth = scriptedAuth({
            prepareAuthorize: async () => ({
                authorizeUrl: 'https://idp.example/auth',
                codeVerifier: 'v',
                state: 's',
                redirectUri: 'http://localhost:33423/callback',
            }),
            exchangeCode: async () => tokenData({ access_token: 'first' }),
        });
        const cb = fakeCallbackServer({ result: { code: 'c', state: 's' } });
        const tm = new TokenManager({
            auth,
            store,
            createCallbackServer: () => cb.server,
            openBrowser: () => undefined,
        });
        const out = await tm.getAccessToken({ forceRefresh: false });
        expect(out).toBe('first');
        expect(store.inspect()?.access_token).toBe('first');
    });

    it('runs PKCE when cached tokens have no refresh_token', async () => {
        const store = memoryStore(
            tokenData({ expires_at: Date.now() - 1, refresh_token: undefined }),
        );
        const auth = scriptedAuth({
            prepareAuthorize: async () => ({
                authorizeUrl: 'https://idp.example/auth',
                codeVerifier: 'v',
                state: 's',
                redirectUri: 'http://localhost:33423/callback',
            }),
            exchangeCode: async () => tokenData({ access_token: 'pkce' }),
        });
        const cb = fakeCallbackServer({ result: { code: 'c', state: 's' } });
        const tm = new TokenManager({
            auth,
            store,
            createCallbackServer: () => cb.server,
        });
        expect(await tm.getAccessToken({ forceRefresh: false })).toBe('pkce');
    });
});

describe('PKCE callback errors', () => {
    it('stops the server and rethrows when awaitCallback rejects', async () => {
        const store = memoryStore(null);
        const auth = scriptedAuth({
            prepareAuthorize: async () => ({
                authorizeUrl: 'https://idp.example/auth',
                codeVerifier: 'v',
                state: 's',
                redirectUri: 'http://localhost:33423/callback',
            }),
        });
        const cb = fakeCallbackServer({ error: new Error('user closed tab') });
        const tm = new TokenManager({
            auth,
            store,
            createCallbackServer: () => cb.server,
        });
        await expect(tm.getAccessToken({ forceRefresh: false })).rejects.toThrow(
            'user closed tab',
        );
        // Server must still be stopped on the failure path.
        expect(cb.stopCalls).toBe(1);
    });
});

describe('logout', () => {
    it('clears the store', async () => {
        const store = memoryStore(tokenData());
        const auth = scriptedAuth();
        const cb = fakeCallbackServer({ result: { code: '', state: '' } });
        const tm = new TokenManager({
            auth,
            store,
            createCallbackServer: () => cb.server,
        });
        await tm.logout();
        expect(store.inspect()).toBeNull();
    });
});

describe('property-based: cross-process token coordination', () => {
    // Each iteration is dominated by `proper-lockfile`'s 50–500 ms jittered
    // retries; with N up to 8, ≥100 runs would push the file past 20 s. We
    // use 30 to stay within the ≤10 s budget per file while still covering
    // every value of N multiple times (~4 iterations per N on average).
    const PBT_RUNS = 30;

    /** Build a TokenManager family that shares a `dataDir`-backed lock. */
    function makeFamily(
        N: number,
        store: ReturnType<typeof memoryStore>,
        auth: ReturnType<typeof scriptedAuth>,
        dataDir: string,
    ): TokenManager[] {
        const cb = fakeCallbackServer({ result: { code: 'c', state: 's' } });
        // SEPARATE coordinators per manager — siblings discover each other
        // only through the on-disk lock file under `dataDir`, which mimics
        // cross-process semantics.
        return Array.from({ length: N }, () =>
            new TokenManager({
                auth,
                store,
                createCallbackServer: () => cb.server,
                openBrowser: async () => undefined,
                lock: new LockCoordinator({ dataDir }),
                namespace: 'pbt-ns',
                lockTimeoutMs: 30_000,
            }),
        );
    }

    // Feature: concurrent-client-safety, Property 1: At-most-one PKCE per namespace
    it('Property 1: at-most-one PKCE per namespace', async () => {
        await fc.assert(
            fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (N) => {
                const dataDir = await mkdtemp(path.join(tmpdir(), 'pbt-mgr1-'));
                try {
                    const store = memoryStore(null);
                    const auth = scriptedAuth({
                        prepareAuthorize: async () => ({
                            authorizeUrl: 'https://idp.example/auth',
                            codeVerifier: 'v',
                            state: 's',
                            redirectUri: 'http://localhost:33423/callback',
                        }),
                        exchangeCode: async () =>
                            tokenData({ access_token: 'pkce-token' }),
                    });
                    const managers = makeFamily(N, store, auth, dataDir);
                    const results = await Promise.all(
                        managers.map((m) => m.getAccessToken({ forceRefresh: false })),
                    );
                    const prepareCalls = auth.calls.filter(
                        (c) => c.method === 'prepareAuthorize',
                    ).length;
                    expect(prepareCalls).toBe(1);
                    expect(results.every((r) => r === results[0])).toBe(true);
                } finally {
                    await rm(dataDir, { recursive: true, force: true });
                }
            }),
            { numRuns: PBT_RUNS },
        );
    }, 60_000);

    // Feature: concurrent-client-safety, Property 2: At-most-one refresh per namespace
    it('Property 2: at-most-one refresh per namespace', async () => {
        await fc.assert(
            fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (N) => {
                const dataDir = await mkdtemp(path.join(tmpdir(), 'pbt-mgr2-'));
                try {
                    const store = memoryStore(
                        tokenData({
                            access_token: 'old',
                            refresh_token: 'rt',
                            expires_at: Date.now() - 1_000,
                        }),
                    );
                    // `prepareAuthorize` is intentionally NOT stubbed: the
                    // default throws, so any unexpected PKCE attempt fails
                    // the property loudly rather than silently doing PKCE.
                    const auth = scriptedAuth({
                        refresh: async () =>
                            tokenData({
                                access_token: 'refreshed',
                                refresh_token: 'rt-new',
                            }),
                    });
                    const managers = makeFamily(N, store, auth, dataDir);
                    const results = await Promise.all(
                        managers.map((m) => m.getAccessToken({ forceRefresh: false })),
                    );
                    const refreshCalls = auth.calls.filter(
                        (c) => c.method === 'refresh',
                    ).length;
                    const prepareCalls = auth.calls.filter(
                        (c) => c.method === 'prepareAuthorize',
                    ).length;
                    expect(refreshCalls).toBe(1);
                    expect(prepareCalls).toBe(0);
                    expect(results.every((r) => r === 'refreshed')).toBe(true);
                } finally {
                    await rm(dataDir, { recursive: true, force: true });
                }
            }),
            { numRuns: PBT_RUNS },
        );
    }, 60_000);
});
