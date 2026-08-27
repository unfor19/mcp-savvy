/**
 * Property-based tests for the cli command handlers. Implements
 * task 8.3 (Property 8: `--login` idempotence on fresh cache).
 *
 * The matrix tests in `commands.matrix.test.ts` cover the seven
 * design-row exit codes. This file complements those with a single
 * universal property: any `expires_at` strictly past the refresh
 * buffer must produce a no-op `--login`. No browser, no token-store
 * write, no observable change in the persisted bundle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import type { Logger } from '@mcp-savvy/core';
import { login, type CommandDeps } from './index.js';
import {
    tokenData,
    memoryStore,
    scriptedAuth,
    fakeCallbackServer,
    fakeLockCoordinator,
    TEST_CONFIG,
} from '../testFixtures.js';

/** No-op logger; the property doesn't assert on log records. */
function nullLogger(): Logger {
    const log: Logger = {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        child: () => log,
    };
    return log;
}

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
    stderrSpy.mockRestore();
});

describe('commands (property-based)', () => {
    // Feature: concurrent-client-safety, Property 8: --login idempotence on fresh cache
    // Validates: Requirements 6.1, 6.7
    it('Property 8: --login is a no-op when cached tokens are fresh', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 61_000, max: 3_600_000 }),
                async (expiresInMs) => {
                    const initial = tokenData({
                        access_token: 'cached',
                        expires_at: Date.now() + expiresInMs,
                    });
                    const store = memoryStore(initial);
                    const setSpy = vi.spyOn(store, 'set');
                    // `scriptedAuth()` with no overrides throws on every method;
                    // any refresh/PKCE attempt would surface as a test failure
                    // rather than be silently swallowed.
                    const auth = scriptedAuth();
                    let browserOpens = 0;
                    const before = store.inspect();
                    const deps: CommandDeps = {
                        auth,
                        store,
                        createCallbackServer: () =>
                            fakeCallbackServer({ result: { code: '', state: '' } }).server,
                        createBridge: () => {
                            throw new Error('bridge should not be built for --login');
                        },
                        openBrowser: () => {
                            browserOpens += 1;
                        },
                        logger: nullLogger(),
                        lock: fakeLockCoordinator(),
                        namespace: 'pbt-ns',
                        lockTimeoutMs: 300_000,
                    };

                    const code = await login(TEST_CONFIG, deps);

                    expect(code).toBe(0);
                    expect(browserOpens).toBe(0);
                    expect(setSpy).not.toHaveBeenCalled();
                    expect(store.inspect()).toEqual(before);
                    // No auth-provider method was reached.
                    expect(auth.calls).toEqual([]);
                },
            ),
            { numRuns: 100 },
        );
    });
});
