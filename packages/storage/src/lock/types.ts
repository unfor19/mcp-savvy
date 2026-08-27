/**
 * Public types for the LockCoordinator.
 *
 * The coordinator serializes token-store mutations across processes
 * sharing the same data directory. These interfaces are the public
 * contract consumed by `@mcp-savvy/cli` and any other caller that
 * needs to take the per-namespace mutex.
 */

import type { Logger } from '@mcp-savvy/core';

/** Options accepted by `LockCoordinator.acquire`. */
export interface AcquireOptions {
    /** Lock namespace; derives the lock-file basename. Same value as the Token Namespace. */
    namespace: string;
    /** Max time to wait for acquisition before timing out. */
    timeoutMs: number;
}

/** Opaque handle returned by `acquire`; pass to `release`. */
export interface LockHandle {
    /** Namespace this handle is scoped to. */
    readonly namespace: string;
    /** Short id used to correlate `lock.acquire` / `lock.release` log records. */
    readonly correlationId: string;
    /** `Date.now()` at the moment acquisition succeeded. */
    readonly acquiredAt: number;
    /** Internal: `proper-lockfile`'s release function. */
    readonly _release: () => Promise<void>;
}

/** Constructor options for `LockCoordinator`. */
export interface LockCoordinatorOptions {
    /** Root data directory; the lock file lives at `${dataDir}/locks/${namespace}.lock`. */
    dataDir: string;
    /** Heartbeat interval. Default 2000 ms; range 1000–30000. */
    heartbeatIntervalMs?: number;
    /** Staleness threshold. Default 10000 ms; range 5000–300000. Must be ≥ 3× heartbeat. */
    stalenessThresholdMs?: number;
    /** Logger; falls back to a no-op logger if not provided. */
    logger?: Logger;
}
