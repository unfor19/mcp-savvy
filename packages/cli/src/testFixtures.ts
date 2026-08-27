/**
 * Test-only fixtures for the cli package. Excluded from build and
 * coverage.
 */

import type { Logger, TokenData } from '@mcp-savvy/core';
import type { AuthProvider, AuthorizePrep } from '@mcp-savvy/auth';
import type { LockCoordinator, TokenStore } from '@mcp-savvy/storage';
import type { CallbackServer } from '@mcp-savvy/server';
import type { CliConfig } from './env.js';

/** Build a fresh `TokenData` that's still valid for `seconds` more. */
export function tokenData(overrides?: Partial<TokenData>): TokenData {
    return {
        access_token: 'access',
        refresh_token: 'refresh',
        id_token: 'id',
        expires_at: Date.now() + 3_600_000,
        ...overrides,
    };
}

/** In-memory `TokenStore` for tests. */
export function memoryStore(initial: TokenData | null = null): TokenStore & {
    inspect(): TokenData | null;
} {
    let value = initial;
    return {
        async get() {
            return value;
        },
        async set(t: TokenData) {
            value = t;
        },
        async clear() {
            value = null;
        },
        inspect() {
            return value;
        },
    };
}

/** Scripted `AuthProvider`. Default implementations throw on unexpected calls. */
export function scriptedAuth(
    overrides: Partial<AuthProvider> = {},
): AuthProvider & { calls: { method: string; arg?: unknown }[] } {
    const calls: { method: string; arg?: unknown }[] = [];
    const stub: AuthProvider = {
        prepareAuthorize: async (): Promise<AuthorizePrep> => {
            calls.push({ method: 'prepareAuthorize' });
            throw new Error('prepareAuthorize not stubbed');
        },
        exchangeCode: async (input) => {
            calls.push({ method: 'exchangeCode', arg: input });
            throw new Error('exchangeCode not stubbed');
        },
        refresh: async (refreshToken) => {
            calls.push({ method: 'refresh', arg: refreshToken });
            throw new Error('refresh not stubbed');
        },
        ...overrides,
    };
    // Wrap overrides so calls are recorded.
    const wrapped: AuthProvider = {
        prepareAuthorize: async () => {
            calls.push({ method: 'prepareAuthorize' });
            return stub.prepareAuthorize();
        },
        exchangeCode: async (input) => {
            calls.push({ method: 'exchangeCode', arg: input });
            return stub.exchangeCode(input);
        },
        refresh: async (token) => {
            calls.push({ method: 'refresh', arg: token });
            return stub.refresh(token);
        },
    };
    return Object.assign(wrapped, { calls });
}

/** Fake `CallbackServer` that resolves a scripted result. */
export function fakeCallbackServer(
    options: { result: { code: string; state: string } } | { error: Error },
): { server: CallbackServer; listenCalls: number; stopCalls: number } {
    let listenCalls = 0;
    let stopCalls = 0;
    const server: CallbackServer = {
        get redirectUri() {
            return 'http://localhost:33423/callback';
        },
        async listen() {
            listenCalls += 1;
            return new URL('http://localhost:33423/callback');
        },
        async awaitCallback() {
            if ('error' in options) throw options.error;
            return options.result;
        },
        async stop() {
            stopCalls += 1;
        },
    } as unknown as CallbackServer;
    return {
        server,
        get listenCalls() {
            return listenCalls;
        },
        get stopCalls() {
            return stopCalls;
        },
    };
}

/**
 * In-memory `LockCoordinator` stand-in. Runs `fn` directly with no
 * filesystem activity; sufficient for unit tests that only need the
 * critical-section shape, not real cross-process exclusion.
 */
export function fakeLockCoordinator(): LockCoordinator {
    const stub = {
        async withLock<T>(
            _opts: { namespace: string; timeoutMs: number },
            fn: (handle: unknown) => Promise<T>,
        ): Promise<T> {
            return fn({
                namespace: _opts.namespace,
                correlationId: 'test',
                acquiredAt: Date.now(),
                _release: async () => undefined,
            });
        },
    };
    return stub as unknown as LockCoordinator;
}

/** Logger fake that captures every record for test assertions. */
export function fakeLogger(): Logger & { records: { level: string; msg: string }[] } {
    const records: { level: string; msg: string }[] = [];
    const log: Logger = {
        debug: (msg) => records.push({ level: 'debug', msg }),
        info: (msg) => records.push({ level: 'info', msg }),
        warn: (msg) => records.push({ level: 'warn', msg }),
        error: (msg) => records.push({ level: 'error', msg }),
        child: () => log,
    };
    return Object.assign(log, { records });
}

/** Canonical `CliConfig` used across the command-handler test suite. */
export const TEST_CONFIG: CliConfig = {
    provider: 'cognito',
    remoteUrl: 'https://example.com/mcp',
    issuer: 'https://idp.example.com',
    clientId: 'client-abc',
    scopes: 'openid email profile',
    callbackHost: 'localhost',
    callbackPort: 33423,
    callbackPath: '/callback',
    tokenNamespace: undefined,
    brandName: undefined,
    completeSessionUrl: undefined,
    toolMode: 'passthrough',
    toolPrefix: 'mcp_savvy',
    debug: false,
    lockTimeoutMs: 300_000,
    lockStaleMs: 10_000,
    shutdownDeadlineMs: 5_000,
    dataDir: '/tmp/mcp-savvy-test',
};

/** Shared lock/namespace/timeout values for `CommandDeps` constructions. */
export const TEST_LOCK_DEPS = {
    lock: fakeLockCoordinator(),
    namespace: 'test-namespace',
    lockTimeoutMs: 300_000,
};
