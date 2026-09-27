/** Acceptance matrix for locked TokenManager decisions and side-effect ordering. */

import { describe, expect, it } from 'vitest';
import { AuthError, LockError, type TokenData } from '@mcp-savvy/core';
import type { LockCoordinator, TokenStore } from '@mcp-savvy/storage';
import type { AuthDiagnosticEmitter } from './diagnostics.js';
import { TokenManager } from './manager.js';
import { fakeCallbackServer, scriptedAuth, tokenData } from '../testFixtures.js';

function diagnostics(events: string[]): AuthDiagnosticEmitter {
    return {
        initialization: () => undefined,
        backendRead: () => undefined,
        credential: (reason, hasRefresh) =>
            events.push(`credential:${reason}:${String(hasRefresh)}`),
        refresh: (reason) => events.push(`refresh:${reason}`),
        interactiveSignIn: (reason) => events.push(`interactive:${reason}`),
        lockTimeout: (namespace, timeoutMs) =>
            events.push(`timeout:${namespace}:${String(timeoutMs)}`),
        reauthentication: () => undefined,
    };
}

const PREP = {
    authorizeUrl: 'https://idp.example/authorize',
    codeVerifier: 'synthetic-verifier',
    state: 'synthetic-state',
    redirectUri: 'http://localhost:33423/callback',
};

describe('TokenManager decision matrix', () => {
    it.each([
        {
            name: 'fresh',
            expiresAt: 61_001,
            expected: 'cached',
            credentialReason: 'credential-fresh',
            refreshCalls: 0,
        },
        {
            name: 'stale',
            expiresAt: 61_000,
            expected: 'refreshed',
            credentialReason: 'credential-stale',
            refreshCalls: 1,
        },
        {
            name: 'invalid',
            expiresAt: Number.NaN,
            expected: 'refreshed',
            credentialReason: 'recorded-expiry-invalid',
            refreshCalls: 1,
        },
    ])('handles $name recorded expiry deterministically', async (row) => {
        const events: string[] = [];
        let stored = tokenData({ access_token: 'cached', expires_at: row.expiresAt });
        const auth = scriptedAuth({
            refresh: async () => tokenData({ access_token: 'refreshed' }),
        });
        const manager = new TokenManager({
            auth,
            store: {
                get: async () => stored,
                set: async (tokens) => {
                    stored = tokens;
                },
                clear: async () => undefined,
            },
            createCallbackServer: () =>
                fakeCallbackServer({ result: { code: '', state: '' } }).server,
            diagnostics: diagnostics(events),
            now: () => 1_000,
        });

        await expect(manager.getAccessToken({ forceRefresh: false })).resolves.toBe(row.expected);
        expect(events[0]).toBe(`credential:${row.credentialReason}:true`);
        expect(auth.calls.filter(({ method }) => method === 'refresh')).toHaveLength(
            row.refreshCalls,
        );
        if (row.refreshCalls === 1) expect(events).toContain('refresh:refresh-succeeded');
    });

    it.each([
        {
            name: 'refresh rejection',
            cached: tokenData({ expires_at: 0 }),
            error: new AuthError('TOKEN_REFRESH_FAILED', 'synthetic rejection'),
            refreshReason: 'refresh-rejected',
            interactiveReason: 'refresh-rejected',
        },
        {
            name: 'refresh runtime error',
            cached: tokenData({ expires_at: 0 }),
            error: new Error('synthetic network failure'),
            refreshReason: 'refresh-error',
            interactiveReason: 'refresh-error',
        },
        {
            name: 'no refresh credential',
            cached: tokenData({ expires_at: 0, refresh_token: undefined }),
            error: undefined,
            refreshReason: 'refresh-unavailable',
            interactiveReason: 'refresh-unavailable',
        },
        {
            name: 'empty cache',
            cached: null,
            error: undefined,
            refreshReason: 'refresh-unavailable',
            interactiveReason: 'credential-missing',
        },
    ])('runs PKCE after $name and emits before browser launch', async (row) => {
        const events: string[] = [];
        const browserSnapshots: string[][] = [];
        const callback = fakeCallbackServer({ result: { code: 'code', state: PREP.state } });
        const auth = scriptedAuth({
            ...(row.error
                ? {
                    refresh: async () => {
                        throw row.error;
                    },
                }
                : {}),
            prepareAuthorize: async () => PREP,
            exchangeCode: async () => tokenData({ access_token: 'pkce' }),
        });
        const manager = new TokenManager({
            auth,
            store: {
                get: async () => row.cached,
                set: async () => undefined,
                clear: async () => undefined,
            },
            createCallbackServer: () => callback.server,
            openBrowser: async () => browserSnapshots.push([...events]),
            diagnostics: diagnostics(events),
            now: () => 1_000,
        });

        await expect(manager.getAccessToken({ forceRefresh: false })).resolves.toBe('pkce');
        expect(events).toContain(`refresh:${row.refreshReason}`);
        expect(browserSnapshots[0]).toContain(`interactive:${row.interactiveReason}`);
    });
});

describe('TokenManager lock and persistence matrix', () => {
    it('reads under the lock and persists refresh before releasing it', async () => {
        const order: string[] = [];
        const lock = {
            withLock: async <T>(_opts: unknown, fn: () => Promise<T>): Promise<T> => {
                order.push('lock-enter');
                const result = await fn();
                order.push('lock-release');
                return result;
            },
        } as unknown as LockCoordinator;
        const manager = new TokenManager({
            auth: scriptedAuth({
                refresh: async () => {
                    order.push('refresh');
                    return tokenData({ access_token: 'refreshed' });
                },
            }),
            store: {
                get: async () => {
                    order.push('store-get');
                    return tokenData({ expires_at: 0 });
                },
                set: async () => {
                    order.push('store-set');
                },
                clear: async () => undefined,
            },
            createCallbackServer: () => {
                throw new Error('PKCE must not start');
            },
            lock,
            namespace: 'matrix',
            lockTimeoutMs: 500,
            now: () => 1_000,
        });

        await expect(manager.getAccessToken({ forceRefresh: false })).resolves.toBe('refreshed');
        expect(order).toEqual([
            'lock-enter',
            'store-get',
            'refresh',
            'store-set',
            'lock-release',
        ]);
    });

    it('re-reads after lock acquisition and uses a sibling credential', async () => {
        let stored = tokenData({ access_token: 'stale', expires_at: 0 });
        let reads = 0;
        const auth = scriptedAuth();
        const lock = {
            withLock: async <T>(_opts: unknown, fn: () => Promise<T>): Promise<T> => {
                stored = tokenData({ access_token: 'sibling-fresh', expires_at: 99_999 });
                return fn();
            },
        } as unknown as LockCoordinator;
        const manager = new TokenManager({
            auth,
            store: {
                get: async () => {
                    reads += 1;
                    return stored;
                },
                set: async () => undefined,
                clear: async () => undefined,
            },
            createCallbackServer: () => {
                throw new Error('PKCE must not start');
            },
            lock,
            namespace: 'matrix',
            lockTimeoutMs: 500,
            now: () => 1_000,
        });

        await expect(manager.getAccessToken({ forceRefresh: false })).resolves.toBe('sibling-fresh');
        expect(reads).toBe(1);
        expect(auth.calls).toEqual([]);
    });

    it('propagates persistence failure without selecting PKCE', async () => {
        let browserLaunches = 0;
        const auth = scriptedAuth({
            refresh: async () => tokenData({ access_token: 'not-persisted' }),
        });
        const manager = new TokenManager({
            auth,
            store: {
                get: async () => tokenData({ expires_at: 0 }),
                set: async () => {
                    throw new Error('synthetic write failure');
                },
                clear: async () => undefined,
            },
            createCallbackServer: () =>
                fakeCallbackServer({ result: { code: '', state: '' } }).server,
            openBrowser: async () => {
                browserLaunches += 1;
            },
            now: () => 1_000,
        });

        await expect(manager.getAccessToken({ forceRefresh: false })).rejects.toMatchObject({
            code: 'TOKEN_STORE_WRITE_FAILED',
        });
        expect(browserLaunches).toBe(0);
        expect(auth.calls.map(({ method }) => method)).toEqual(['refresh']);
    });

    it('times out before every store, auth, callback, and browser side effect', async () => {
        const sideEffects: string[] = [];
        const events: string[] = [];
        const timeout = new LockError('LOCK_ACQUISITION_TIMEOUT', 'synthetic timeout');
        const store: TokenStore = {
            get: async () => {
                sideEffects.push('store-get');
                return null;
            },
            set: async () => sideEffects.push('store-set'),
            clear: async () => sideEffects.push('store-clear'),
        };
        const manager = new TokenManager({
            auth: scriptedAuth({
                refresh: async () => {
                    sideEffects.push('refresh');
                    return tokenData();
                },
                prepareAuthorize: async () => {
                    sideEffects.push('prepare');
                    return PREP;
                },
            }),
            store,
            createCallbackServer: () => {
                sideEffects.push('callback-server');
                return fakeCallbackServer({ result: { code: '', state: '' } }).server;
            },
            openBrowser: async () => sideEffects.push('browser'),
            diagnostics: diagnostics(events),
            lock: {
                withLock: async () => {
                    throw timeout;
                },
            } as unknown as LockCoordinator,
            namespace: 'matrix',
            lockTimeoutMs: 750,
        });

        await expect(manager.getAccessToken({ forceRefresh: false })).rejects.toBe(timeout);
        expect(sideEffects).toEqual([]);
        expect(events).toEqual(['timeout:matrix:750']);
    });
});
