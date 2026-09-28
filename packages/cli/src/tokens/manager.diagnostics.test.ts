/** Focused deterministic-classification and diagnostic tests for TokenManager. */

import { describe, expect, it } from 'vitest';
import { AuthError, LockError, type TokenData } from '@mcp-savvy/core';
import type { AuthDiagnosticEmitter } from './diagnostics.js';
import { classifyCredential, TokenManager } from './manager.js';
import {
    fakeCallbackServer,
    memoryStore,
    scriptedAuth,
    tokenData,
} from '../testFixtures.js';

function recordingDiagnostics(): AuthDiagnosticEmitter & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        initialization: () => calls.push('initialization'),
        backendRead: (_backend, reason) => calls.push(`backend:${reason}`),
        credential: (reason, hasRefresh) =>
            calls.push(`credential:${reason}:${String(hasRefresh)}`),
        refresh: (reason) => calls.push(`refresh:${reason}`),
        interactiveSignIn: (reason) => calls.push(`interactive:${reason}`),
        lockTimeout: (namespace, timeoutMs) =>
            calls.push(`lock-timeout:${namespace}:${String(timeoutMs)}`),
        reauthentication: (consumed, budget) =>
            calls.push(`reauthentication:${String(consumed)}:${String(budget)}`),
    };
}

function pkceAuth(refreshError?: Error) {
    return scriptedAuth({
        ...(refreshError
            ? {
                refresh: async () => {
                    throw refreshError;
                },
            }
            : {}),
        prepareAuthorize: async () => ({
            authorizeUrl: 'https://idp.example/authorize',
            codeVerifier: 'verifier',
            state: 'state',
            redirectUri: 'http://localhost:33423/callback',
        }),
        exchangeCode: async () => tokenData({ access_token: 'pkce' }),
    });
}

describe('classifyCredential', () => {
    const now = 1_000_000;

    it('uses a strict 60-second freshness boundary', () => {
        expect(classifyCredential(tokenData({ expires_at: now + 60_001 }), now)).toBe(
            'credential-fresh',
        );
        expect(classifyCredential(tokenData({ expires_at: now + 60_000 }), now)).toBe(
            'credential-stale',
        );
        expect(classifyCredential(tokenData({ expires_at: now + 59_999 }), now)).toBe(
            'credential-stale',
        );
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
        'classifies non-finite expiry %s as invalid',
        (expiresAt) => {
            expect(classifyCredential(tokenData({ expires_at: expiresAt }), now)).toBe(
                'recorded-expiry-invalid',
            );
        },
    );
});

describe('TokenManager diagnostics', () => {
    it('uses the injected clock for locked fresh-credential classification', async () => {
        const diagnostics = recordingDiagnostics();
        let storeReads = 0;
        const stored = tokenData({ access_token: 'cached', expires_at: 61_000 });
        const manager = new TokenManager({
            auth: scriptedAuth(),
            store: {
                async get() {
                    storeReads += 1;
                    return stored;
                },
                async set() {
                    throw new Error('unexpected write');
                },
                async clear() {
                    throw new Error('unexpected clear');
                },
            },
            createCallbackServer: () =>
                fakeCallbackServer({ result: { code: '', state: '' } }).server,
            diagnostics,
            now: () => 0,
        });

        await expect(manager.getAccessToken({ forceRefresh: false })).resolves.toBe('cached');
        expect(storeReads).toBe(1);
        expect(diagnostics.calls).toEqual(['credential:credential-fresh:true']);
    });

    it.each([
        {
            name: 'rejected',
            error: new AuthError('TOKEN_REFRESH_FAILED', 'response-body-secret'),
            reason: 'refresh-rejected',
        },
        { name: 'runtime error', error: new Error('network-secret'), reason: 'refresh-error' },
    ])('categorizes $name and emits PKCE selection before browser launch', async ({ error, reason }) => {
        const diagnostics = recordingDiagnostics();
        const browserObservations: string[][] = [];
        const callback = fakeCallbackServer({ result: { code: 'code', state: 'state' } });
        const manager = new TokenManager({
            auth: pkceAuth(error),
            store: memoryStore(tokenData({ expires_at: 0, refresh_token: 'refresh-secret' })),
            createCallbackServer: () => callback.server,
            openBrowser: async () => browserObservations.push([...diagnostics.calls]),
            diagnostics,
            now: () => 1_000_000,
        });

        await expect(manager.getAccessToken({ forceRefresh: false })).resolves.toBe('pkce');
        expect(diagnostics.calls).toContain(`refresh:${reason}`);
        expect(browserObservations[0]).toContain(`interactive:${reason}`);
        expect(JSON.stringify(diagnostics.calls)).not.toContain('secret');
    });

    it('prefers an ID token for AgentCore and falls back to the access token', async () => {
        const common = {
            auth: scriptedAuth(),
            createCallbackServer: () =>
                fakeCallbackServer({ result: { code: '', state: '' } }).server,
            now: () => 0,
        };
        const withIdentity = new TokenManager({
            ...common,
            store: memoryStore(tokenData({ access_token: 'access', id_token: 'identity', expires_at: 61_000 })),
            preferIdentityToken: true,
        });
        const withoutIdentity = new TokenManager({
            ...common,
            store: memoryStore(tokenData({ access_token: 'access', id_token: undefined, expires_at: 61_000 })),
            preferIdentityToken: true,
        });

        await expect(withIdentity.getAccessToken({ forceRefresh: false })).resolves.toBe('identity');
        await expect(withoutIdentity.getAccessToken({ forceRefresh: false })).resolves.toBe('access');
    });

    it('reports exact acquisition timeout and performs no store or browser work', async () => {
        const diagnostics = recordingDiagnostics();
        let storeReads = 0;
        let browserLaunches = 0;
        const timeout = new LockError('LOCK_ACQUISITION_TIMEOUT', 'operational detail');
        const manager = new TokenManager({
            auth: scriptedAuth(),
            store: {
                async get(): Promise<TokenData | null> {
                    storeReads += 1;
                    return null;
                },
                async set() { },
                async clear() { },
            },
            createCallbackServer: () =>
                fakeCallbackServer({ result: { code: '', state: '' } }).server,
            openBrowser: async () => {
                browserLaunches += 1;
            },
            diagnostics,
            lock: {
                withLock: async () => {
                    throw timeout;
                },
            } as never,
            namespace: 'safe-namespace',
            lockTimeoutMs: 1_500,
        });

        await expect(manager.getAccessToken({ forceRefresh: false })).rejects.toBe(timeout);
        expect(storeReads).toBe(0);
        expect(browserLaunches).toBe(0);
        expect(diagnostics.calls).toEqual(['lock-timeout:safe-namespace:1500']);
    });
});
