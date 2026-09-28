/**
 * Unit tests for the command handlers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Logger } from '@mcp-savvy/core';
import { runBridge, login, forceLogin, logout, printEnv, type CommandDeps } from './index.js';
import {
    tokenData,
    memoryStore,
    scriptedAuth,
    fakeCallbackServer,
    fakeLogger,
    TEST_CONFIG,
    TEST_LOCK_DEPS,
} from '../testFixtures.js';

const CONFIG = TEST_CONFIG;
const LOCK_DEPS = TEST_LOCK_DEPS;

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
    stderrSpy.mockRestore();
});

describe('runBridge', () => {
    it('runs the bridge end-to-end with an injected token provider', async () => {
        const store = memoryStore(tokenData({ access_token: 'cached' }));
        const auth = scriptedAuth();
        const cb = fakeCallbackServer({ result: { code: 'unused', state: 's' } });
        let runCalled = false;
        let providedToken: string | undefined;
        const deps: CommandDeps = {
            auth,
            store,
            createCallbackServer: () => cb.server,
            createBridge: (getAccessToken) =>
                ({
                    async run() {
                        runCalled = true;
                        providedToken = await getAccessToken({ forceRefresh: false });
                    },
                }) as unknown as ReturnType<CommandDeps['createBridge']>,
            logger: fakeLogger(),
            ...LOCK_DEPS,
        };
        const code = await runBridge(CONFIG, deps);
        expect(code).toBe(0);
        expect(runCalled).toBe(true);
        expect(providedToken).toBe('cached');
    });
});

describe('login', () => {
    it('returns 0 and skips PKCE when cached tokens are fresh (cache-first)', async () => {
        const store = memoryStore(tokenData({ access_token: 'cached' }));
        let pkceCalled = false;
        const auth = scriptedAuth({
            prepareAuthorize: async () => {
                pkceCalled = true;
                return {
                    authorizeUrl: 'https://idp.example/auth',
                    codeVerifier: 'v',
                    state: 's',
                    redirectUri: 'http://localhost:33423/callback',
                };
            },
        });
        const cb = fakeCallbackServer({ result: { code: 'c', state: 's' } });
        const logger = fakeLogger();
        let browserOpens = 0;
        const deps: CommandDeps = {
            auth,
            store,
            createCallbackServer: () => cb.server,
            openBrowser: () => {
                browserOpens += 1;
            },
            createBridge: () => {
                throw new Error('bridge should not be built for --login');
            },
            logger,
            ...LOCK_DEPS,
        };
        const code = await login(CONFIG, deps);
        expect(code).toBe(0);
        expect(pkceCalled).toBe(false);
        expect(browserOpens).toBe(0);
        // Cache untouched.
        expect(store.inspect()?.access_token).toBe('cached');
        expect(logger.records).toContainEqual({
            level: 'info',
            msg: 'already signed in',
        });
    });

    it('refreshes when cached tokens are within the refresh buffer', async () => {
        const store = memoryStore(
            tokenData({ access_token: 'old', expires_at: Date.now() + 30_000 }),
        );
        const auth = scriptedAuth({
            refresh: async () => tokenData({ access_token: 'fresh' }),
        });
        const cb = fakeCallbackServer({ result: { code: 'unused', state: 's' } });
        const logger = fakeLogger();
        const deps: CommandDeps = {
            auth,
            store,
            createCallbackServer: () => cb.server,
            openBrowser: () => undefined,
            createBridge: () => {
                throw new Error('bridge should not be built for --login');
            },
            logger,
            ...LOCK_DEPS,
        };
        const code = await login(CONFIG, deps);
        expect(code).toBe(0);
        expect(store.inspect()?.access_token).toBe('fresh');
        expect(logger.records).toContainEqual({
            level: 'info',
            msg: 'signed in; tokens cached',
        });
    });
});

describe('forceLogin', () => {
    it('clears any cached tokens then triggers PKCE', async () => {
        const store = memoryStore(tokenData({ access_token: 'old' }));
        const auth = scriptedAuth({
            prepareAuthorize: async () => ({
                authorizeUrl: 'https://idp.example/auth',
                codeVerifier: 'v',
                state: 's',
                redirectUri: 'http://localhost:33423/callback',
            }),
            exchangeCode: async () => tokenData({ access_token: 'fresh' }),
        });
        const cb = fakeCallbackServer({ result: { code: 'c', state: 's' } });
        const logger = fakeLogger();
        const deps: CommandDeps = {
            auth,
            store,
            createCallbackServer: () => cb.server,
            openBrowser: () => undefined,
            createBridge: () => {
                throw new Error('bridge should not be built for --force-login');
            },
            logger,
            ...LOCK_DEPS,
        };
        const code = await forceLogin(CONFIG, deps);
        expect(code).toBe(0);
        expect(store.inspect()?.access_token).toBe('fresh');
        expect(logger.records).toContainEqual({
            level: 'info',
            msg: 'signed in; tokens cached',
        });
    });
});

describe('logout', () => {
    it('clears the store and exits 0', async () => {
        const store = memoryStore(tokenData());
        const auth = scriptedAuth();
        const cb = fakeCallbackServer({ result: { code: '', state: '' } });
        const logger = fakeLogger();
        const deps: CommandDeps = {
            auth,
            store,
            createCallbackServer: () => cb.server,
            createBridge: () => {
                throw new Error('bridge should not be built for --logout');
            },
            logger,
            ...LOCK_DEPS,
        };
        const code = await logout(CONFIG, deps);
        expect(code).toBe(0);
        expect(store.inspect()).toBeNull();
    });
});

describe('printEnv', () => {
    it('reports effective identity and backend metadata without authentication side effects', async () => {
        const records: { message: string; fields?: Record<string, unknown> }[] = [];
        const logger: Logger = {
            debug: () => undefined,
            info: (message, fields) => records.push({ message, ...(fields ? { fields } : {}) }),
            warn: () => undefined,
            error: () => undefined,
            child: () => logger,
        };
        const noSideEffect = (): never => {
            throw new Error('print-env must not perform authentication side effects');
        };
        const deps: CommandDeps = {
            auth: {
                prepareAuthorize: noSideEffect,
                exchangeCode: noSideEffect,
                refresh: noSideEffect,
            },
            store: {
                get: noSideEffect,
                set: noSideEffect,
                clear: noSideEffect,
            },
            createCallbackServer: noSideEffect,
            createBridge: noSideEffect,
            logger,
            ...LOCK_DEPS,
            lock: { withLock: noSideEffect } as unknown as CommandDeps['lock'],
        };

        const code = await printEnv(
            { ...CONFIG, clientId: 'complete-client-id-must-not-appear' },
            deps,
        );

        expect(code).toBe(0);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            message: 'resolved config',
            fields: {
                namespace: LOCK_DEPS.effectiveIdentity.namespace,
                dataDir: LOCK_DEPS.effectiveIdentity.dataDir,
                effectiveCacheIdentityFingerprint: LOCK_DEPS.effectiveIdentity.fingerprint,
                componentFingerprints: LOCK_DEPS.effectiveIdentity.componentFingerprints,
                availableBackends: LOCK_DEPS.backendMetadata.available,
                preferredBackend: LOCK_DEPS.backendMetadata.preferred,
                bearerPreference: 'auto',
                resolvedBearerPreference: 'access',
            },
        });
        expect(JSON.stringify(records[0])).not.toContain('complete-client-id-must-not-appear');
        expect(records[0]?.fields).not.toHaveProperty('clientId');
        expect(records[0]?.fields).not.toHaveProperty('tokenNamespace');
    });
});
