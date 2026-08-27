/**
 * Cross-process mutex for token-store mutations, backed by `proper-lockfile`.
 *
 * The coordinator serializes every code path that mutates the Token
 * Store for a given namespace. One lock file per namespace lives under
 * `${dataDir}/locks/${namespace}.lock`; siblings observe its mtime
 * heartbeat to detect dead holders and reclaim stale locks.
 *
 * Logger writes go to stderr only via `@mcp-savvy/core`'s logger —
 * stdout is reserved for MCP JSON-RPC frames.
 */

import { stat } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as lockfile from 'proper-lockfile';

import { LockError } from '@mcp-savvy/core';
import type { Logger } from '@mcp-savvy/core';

import { newCorrelationId } from './correlationId.js';
import type { AcquireOptions, LockCoordinatorOptions, LockHandle } from './types.js';

const DEFAULT_HEARTBEAT_MS = 2000;
const DEFAULT_STALENESS_MS = 10000;

/** Logger used when none is injected; swallows every record. */
const NOOP_LOGGER: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => NOOP_LOGGER,
};

interface Reentry {
    handle: LockHandle;
    count: number;
}

interface LockState {
    compromisedError?: Error;
}

/** Coordinates exclusive access to a Token Namespace across processes on one host. */
export class LockCoordinator {
    private readonly heartbeatIntervalMs: number;
    private readonly stalenessThresholdMs: number;
    private readonly dataDir: string;
    private readonly locksDir: string;
    private readonly logger: Logger;
    private locksDirEnsured = false;
    private readonly reentry = new Map<string, Reentry>();
    private readonly lockStates = new Map<string, LockState>();

    /** Construct a coordinator; validates the heartbeat / staleness ratio. */
    constructor(opts: LockCoordinatorOptions) {
        this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
        this.stalenessThresholdMs = opts.stalenessThresholdMs ?? DEFAULT_STALENESS_MS;
        if (this.stalenessThresholdMs < 3 * this.heartbeatIntervalMs) {
            throw new LockError(
                'LOCK_CONFIG_INVALID',
                `staleness threshold ${this.stalenessThresholdMs}ms must be at least 3x heartbeat interval ${this.heartbeatIntervalMs}ms`,
            );
        }
        this.dataDir = opts.dataDir;
        this.locksDir = path.join(this.dataDir, 'locks');
        this.logger = opts.logger ?? NOOP_LOGGER;
    }

    /** Acquire the namespace lock, waiting at most `timeoutMs` before throwing. */
    async acquire(opts: AcquireOptions): Promise<LockHandle> {
        await this.ensureLocksDir(opts.namespace);

        const lockfilePath = path.join(this.locksDir, `${opts.namespace}.lock`);
        const correlationId = newCorrelationId();
        const startedAt = Date.now();

        await this.maybeReportStaleReclaim(lockfilePath, opts.namespace);

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
                timedOut = true;
                const waitedMs = Date.now() - startedAt;
                this.logger.warn('lock.timeout', {
                    namespace: opts.namespace,
                    pid: process.pid,
                    timeoutMs: opts.timeoutMs,
                    waitedMs,
                });
                reject(
                    new LockError(
                        'LOCK_ACQUISITION_TIMEOUT',
                        `lock acquisition for namespace ${opts.namespace} timed out after ${opts.timeoutMs}ms`,
                    ),
                );
            }, opts.timeoutMs);
            timeoutHandle.unref?.();
        });

        const acquirePromise = this.callLockfileLock(
            lockfilePath,
            opts.namespace,
            correlationId,
        ).then((release) => {
            if (timedOut) {
                release().catch(() => undefined);
                this.lockStates.delete(correlationId);
                throw new LockError(
                    'LOCK_ACQUISITION_TIMEOUT',
                    `lock acquisition for namespace ${opts.namespace} timed out after ${opts.timeoutMs}ms`,
                );
            }
            return release;
        });

        try {
            const release = await Promise.race([acquirePromise, timeoutPromise]);
            const acquiredAt = Date.now();
            const handle: LockHandle = {
                namespace: opts.namespace,
                correlationId,
                acquiredAt,
                _release: release,
            };
            this.logger.debug('lock.acquire', {
                namespace: opts.namespace,
                pid: process.pid,
                correlationId,
                waitedMs: acquiredAt - startedAt,
            });
            return handle;
        } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
        }
    }

    /** Release a previously acquired handle. Swallows already-released errors. */
    async release(handle: LockHandle): Promise<void> {
        const state = this.lockStates.get(handle.correlationId);
        this.lockStates.delete(handle.correlationId);
        let releaseErr: unknown;
        try {
            await handle._release();
        } catch (err) {
            const code = (err as NodeJS.ErrnoException | undefined)?.code;
            if (code !== 'ENOTACQUIRED' && code !== 'ERELEASED') {
                releaseErr = err;
            }
        }
        this.logger.debug('lock.release', {
            namespace: handle.namespace,
            pid: process.pid,
            correlationId: handle.correlationId,
            heldMs: Date.now() - handle.acquiredAt,
        });
        if (state?.compromisedError) {
            throw new LockError(
                'LOCK_HEARTBEAT_FAILED',
                `lock heartbeat failed for namespace ${handle.namespace}: ${state.compromisedError.message}`,
                state.compromisedError,
            );
        }
        if (releaseErr) throw releaseErr;
    }

    /** Acquire, run `fn`, release. Short-circuits reentry within the same process. */
    async withLock<T>(
        opts: AcquireOptions,
        fn: (handle: LockHandle) => Promise<T>,
    ): Promise<T> {
        const existing = this.reentry.get(opts.namespace);
        if (existing) {
            existing.count += 1;
            try {
                return await fn(existing.handle);
            } finally {
                existing.count -= 1;
            }
        }

        const handle = await this.acquire(opts);
        this.reentry.set(opts.namespace, { handle, count: 1 });
        try {
            return await fn(handle);
        } finally {
            const entry = this.reentry.get(opts.namespace);
            if (entry) {
                entry.count -= 1;
                if (entry.count <= 0) {
                    this.reentry.delete(opts.namespace);
                    await this.release(handle);
                }
            }
        }
    }

    private async ensureLocksDir(namespace: string): Promise<void> {
        if (this.locksDirEnsured) return;
        try {
            await mkdir(this.locksDir, { recursive: true, mode: 0o700 });
            this.locksDirEnsured = true;
        } catch (err) {
            throw new LockError(
                'LOCK_DIRECTORY_UNAVAILABLE',
                `failed to prepare lock directory ${this.locksDir} for namespace ${namespace}`,
                err,
            );
        }
    }

    private async maybeReportStaleReclaim(
        lockfilePath: string,
        namespace: string,
    ): Promise<void> {
        try {
            const info = await stat(lockfilePath);
            const heartbeatAgeMs = Date.now() - info.mtimeMs;
            if (heartbeatAgeMs > this.stalenessThresholdMs) {
                this.logger.warn('lock.stale-reclaim', {
                    namespace,
                    pid: process.pid,
                    heartbeatAgeMs,
                });
            }
        } catch {
            // No lock file present — nothing to reclaim. Other errors propagate
            // when we call `proper-lockfile.lock` below.
        }
    }

    private async callLockfileLock(
        lockfilePath: string,
        namespace: string,
        correlationId: string,
    ): Promise<() => Promise<void>> {
        const state: LockState = {};
        this.lockStates.set(correlationId, state);
        try {
            return await lockfile.lock(lockfilePath, {
                // `forever: true` cycles the seed timeouts indefinitely;
                // the outer `Promise.race([acquire, timeoutPromise])` in
                // `acquire` enforces the user-visible `timeoutMs`.
                // We use a small finite `retries` (10) so the seed
                // timeout list stays tiny — passing `Infinity` here would
                // crash the underlying `retry` library
                // (`for (var i = 0; i < Infinity; i++) timeouts.push(...)`
                // throws `RangeError: Invalid array length`).
                retries: {
                    forever: true,
                    retries: 10,
                    minTimeout: 50,
                    maxTimeout: 500,
                    randomize: true,
                    factor: 1,
                },
                update: this.heartbeatIntervalMs,
                stale: this.stalenessThresholdMs,
                lockfilePath,
                realpath: false,
                onCompromised: (err: Error) => {
                    state.compromisedError = err;
                    this.logger.warn('lock.heartbeat-failed', {
                        namespace,
                        pid: process.pid,
                        correlationId,
                        cause: err.message,
                    });
                },
            });
        } catch (err) {
            this.lockStates.delete(correlationId);
            const code = (err as NodeJS.ErrnoException | undefined)?.code;
            if (
                code === 'EACCES' ||
                code === 'EPERM' ||
                code === 'EROFS' ||
                code === 'ENOENT' ||
                code === 'ENOTDIR'
            ) {
                throw new LockError(
                    'LOCK_DIRECTORY_UNAVAILABLE',
                    `lock directory ${this.locksDir} unavailable for namespace ${namespace}`,
                    err,
                );
            }
            throw err;
        }
    }
}
