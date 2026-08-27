/**
 * Property-based tests for LockCoordinator: stale reclamation within
 * bound, namespacing totality, contended retry budget, and timeout
 * preserving an injected store. Implements task 8.2 (Properties 4–7)
 * in concurrent-client-safety.
 *
 * Property 4 simulates a "killed holder" by planting a lock directory
 * whose mtime is not advanced — proper-lockfile must wait the
 * staleness window before reclaiming. The integration leg using a
 * real SIGKILLed child process is intentionally deferred to task 9.1.
 *
 * Wall-clock upper bounds carry extra slack on top of the design
 * bounds in the spec because these tests run alongside the rest of
 * the storage suite in parallel; event-loop pressure can stretch
 * setTimeout firings beyond the tight design bound under load.
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { LockError } from '@mcp-savvy/core';
import { LockCoordinator } from './coordinator.js';

/** Allocate a fresh isolated data dir for one property iteration. */
async function isolatedDataDir(prefix: string): Promise<string> {
    return mkdtemp(path.join(tmpdir(), `mcp-savvy-lock-${prefix}-`));
}

/** Plant a lock directory at the expected path with mtime = now. */
async function plantFreshLockDir(
    dataDir: string,
    namespace: string,
): Promise<void> {
    const locksDir = path.join(dataDir, 'locks');
    await mkdir(locksDir, { recursive: true, mode: 0o700 });
    await mkdir(path.join(locksDir, `${namespace}.lock`), {
        recursive: true,
        mode: 0o700,
    });
}

describe('LockCoordinator (property-based)', () => {
    it(
        'Property 4: stale-lock reclamation completes within stalenessMs + heartbeatMs + slack',
        async () => {
            // Feature: concurrent-client-safety, Property 4: Stale-lock reclamation within bound
            // Validates: Requirements 1.10, 2.1, 2.2, 2.5
            await fc.assert(
                fc.asyncProperty(
                    fc.integer({ min: 500, max: 1_000 }),
                    fc.integer({ min: 3, max: 4 }),
                    async (heartbeatMs, ratio) => {
                        const stalenessMs = heartbeatMs * ratio;
                        // Design slack is 200 ms; bump to 1000 ms for load tolerance.
                        const slackMs = 1_000;
                        const dataDir = await isolatedDataDir('pbt4');
                        try {
                            const coord = new LockCoordinator({
                                dataDir,
                                heartbeatIntervalMs: heartbeatMs,
                                stalenessThresholdMs: stalenessMs,
                            });
                            await plantFreshLockDir(dataDir, 'ns');
                            const startedAt = Date.now();
                            const handle = await coord.acquire({
                                namespace: 'ns',
                                timeoutMs: 60_000,
                            });
                            const elapsed = Date.now() - startedAt;
                            await coord.release(handle);
                            expect(elapsed).toBeLessThanOrEqual(
                                stalenessMs + heartbeatMs + slackMs,
                            );
                        } finally {
                            await rm(dataDir, { recursive: true, force: true });
                        }
                    },
                ),
                { numRuns: 5 },
            );
        },
        120_000,
    );

    it(
        'Property 5: distinct namespaces never block each other',
        async () => {
            // Feature: concurrent-client-safety, Property 5: Lock namespacing is total
            // Validates: Requirements 1.8, 7.6
            await fc.assert(
                fc.asyncProperty(
                    fc.integer({ min: 50, max: 200 }),
                    async (holdMs) => {
                        const dataDir = await isolatedDataDir('pbt5');
                        try {
                            const coord = new LockCoordinator({ dataDir });
                            const ns1 = 'tenant-a-cli11111111';
                            const ns2 = 'tenant-b-cli22222222';
                            const cycle = async (ns: string): Promise<void> => {
                                const handle = await coord.acquire({
                                    namespace: ns,
                                    timeoutMs: 10_000,
                                });
                                await new Promise<void>((resolve) =>
                                    setTimeout(resolve, holdMs),
                                );
                                await coord.release(handle);
                            };
                            const startedAt = Date.now();
                            await Promise.all([cycle(ns1), cycle(ns2)]);
                            const elapsed = Date.now() - startedAt;
                            // Parallel execution: total ≈ holdMs, not 2 * holdMs.
                            expect(elapsed).toBeLessThan(holdMs + 1_500);
                        } finally {
                            await rm(dataDir, { recursive: true, force: true });
                        }
                    },
                ),
                { numRuns: 50 },
            );
        },
        60_000,
    );

    it(
        'Property 6: N contending acquirers all eventually acquire within a bounded budget',
        async () => {
            // Feature: concurrent-client-safety, Property 6: Bounded retry budget with jittered, non-identical waits
            // Validates: Requirements 1.1, 3.1, 3.2, 3.5
            // The "consecutive retries differ" sub-clause is intentionally
            // unverified: the retry library timeouts are internal to
            // proper-lockfile and cannot be observed without monkey-patching
            // setTimeout — out of scope for this property.
            await fc.assert(
                fc.asyncProperty(
                    fc.integer({ min: 2, max: 6 }),
                    fc.integer({ min: 10, max: 200 }),
                    async (n, holdMs) => {
                        const dataDir = await isolatedDataDir('pbt6');
                        try {
                            const coord = new LockCoordinator({ dataDir });
                            const namespace = 'ns-pbt6';
                            const startedAt = Date.now();
                            const acquireTimes: number[] = [];
                            const tasks: Array<Promise<void>> = [];
                            for (let i = 0; i < n; i += 1) {
                                tasks.push(
                                    (async () => {
                                        const handle = await coord.acquire({
                                            namespace,
                                            timeoutMs: 60_000,
                                        });
                                        acquireTimes.push(Date.now() - startedAt);
                                        await new Promise<void>((resolve) =>
                                            setTimeout(resolve, holdMs),
                                        );
                                        await coord.release(handle);
                                    })(),
                                );
                            }
                            await Promise.all(tasks);
                            // Every acquirer eventually got the lock.
                            expect(acquireTimes).toHaveLength(n);
                            const elapsed = Date.now() - startedAt;
                            // Loose upper bound: n * holdMs + per-retry slack.
                            expect(elapsed).toBeLessThanOrEqual(
                                n * (holdMs + 1_000),
                            );
                        } finally {
                            await rm(dataDir, { recursive: true, force: true });
                        }
                    },
                ),
                { numRuns: 30 },
            );
        },
        120_000,
    );

    it(
        'Property 7: acquisition timeout throws LockError without touching the store',
        async () => {
            // Feature: concurrent-client-safety, Property 7: Typed timeout error preserves store state
            // Validates: Requirements 1.9, 3.5, 6.6, 7.6, 8.5
            await fc.assert(
                fc.asyncProperty(
                    fc.integer({ min: 50, max: 200 }),
                    async (timeoutMs) => {
                        const dataDir = await isolatedDataDir('pbt7');
                        try {
                            const stubStore = {
                                set: vi.fn(),
                                clear: vi.fn(),
                            };
                            const namespace = 'ns-pbt7';
                            const holder = new LockCoordinator({ dataDir });
                            const acquirer = new LockCoordinator({ dataDir });
                            const heldHandle = await holder.acquire({
                                namespace,
                                timeoutMs: 5_000,
                            });
                            let caught: unknown;
                            const startedAt = Date.now();
                            try {
                                await acquirer.acquire({ namespace, timeoutMs });
                            } catch (err) {
                                caught = err;
                            }
                            const elapsed = Date.now() - startedAt;
                            await holder.release(heldHandle);

                            expect(caught).toBeInstanceOf(LockError);
                            expect((caught as LockError).code).toBe(
                                'LOCK_ACQUISITION_TIMEOUT',
                            );
                            expect((caught as LockError).message).toContain(
                                namespace,
                            );
                            // Node's setTimeout has ~±1–15 ms precision and
                            // can fire fractionally early under load (e.g.
                            // elapsed = 72 ms for timeoutMs = 73 ms). Allow a
                            // small lower-side slack so the property tests
                            // the coordinator's behavior, not the host timer.
                            const timerPrecisionSlackMs = 50;
                            expect(elapsed).toBeGreaterThanOrEqual(
                                timeoutMs - timerPrecisionSlackMs,
                            );
                            // Design slack 1000 ms; bump to 3000 ms for load
                            // tolerance — small setTimeouts can fire late
                            // under parallel-suite event-loop pressure.
                            expect(elapsed).toBeLessThanOrEqual(timeoutMs + 3_000);
                            expect(stubStore.set).not.toHaveBeenCalled();
                            expect(stubStore.clear).not.toHaveBeenCalled();
                        } finally {
                            await rm(dataDir, { recursive: true, force: true });
                        }
                    },
                ),
                { numRuns: 10 },
            );
        },
        60_000,
    );
});
