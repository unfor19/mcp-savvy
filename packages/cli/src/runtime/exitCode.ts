/**
 * Maps a thrown error to the documented CLI exit code.
 *
 * Lives in its own module so `cli.ts` stays under the fon 300-line
 * limit. The mapping is the canonical implementation of design.md's
 * exit-code matrix and is exercised by the Phase 5.3 command tests.
 */

import { AuthError, LockError } from '@mcp-savvy/core';
import type { CommandDeps } from '../commands/index.js';

/**
 * Map a thrown error to the documented exit code (design.md
 * exit-code matrix). Heuristic — typed-error shape decides the
 * surface:
 *   - `LockError('LOCK_ACQUISITION_TIMEOUT')` → 4 (sibling contention).
 *   - `AuthError('TOKEN_REFRESH_FAILED')` → 5 (refresh rejected and
 *     the PKCE fallback also failed; Phase 5 surfaces the chained
 *     failure under the refresh code).
 *   - anything else → 1 (generic catch-all, preserved for back-compat).
 * Logs an `error`-level stderr line in the format named in the
 * exit-code matrix before returning.
 */
export function exitCodeForError(err: Error, deps: CommandDeps): number {
    if (err instanceof LockError && err.code === 'LOCK_ACQUISITION_TIMEOUT') {
        deps.logger.error(
            `another mcp-savvy process holds the lock for namespace ${deps.namespace}; waited ${deps.lockTimeoutMs}ms`,
        );
        return 4;
    }
    if (err instanceof AuthError && err.code === 'TOKEN_REFRESH_FAILED') {
        deps.logger.error(`refresh rejected and PKCE fallback failed: ${err.message}`);
        return 5;
    }
    deps.logger.error(`fatal: ${err.message}`);
    return 1;
}
