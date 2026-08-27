/**
 * Short correlation-id generator for lock-coordination log records.
 *
 * Every `LockCoordinator` acquire/release pair shares one id so the
 * five structured log records (`lock.acquire`, `lock.release`,
 * `lock.stale-reclaim`, `lock.timeout`, `lock.heartbeat-failed`) can
 * be joined across a single lifecycle without leaking the full UUID.
 */

import { randomUUID } from 'node:crypto';

/** Returns an 8-char correlation id derived from a v4 UUID. */
export function newCorrelationId(): string {
    return randomUUID().slice(0, 8);
}
