/**
 * Live runtime resources owned by a running `mcp-savvy` invocation.
 *
 * Extracted from `cli.ts` so the entrypoint module stays under fon's
 * 300-line limit while Phase 7.2's module-level signal handlers can
 * still hold a reference to the resources they need to clean up.
 */

import type { StdioBridge } from '@mcp-savvy/bridge';
import type { CallbackServer } from '@mcp-savvy/server';
import type { LockCoordinator, LockHandle } from '@mcp-savvy/storage';

/** Holds the live runtime resources that need bounded cleanup on signals. */
export class Cli {
    /** The stdio bridge once `runBridge` has constructed it. Null otherwise. */
    bridge: StdioBridge | null = null;
    /** The PKCE callback HTTP server once it has been listened on. Null otherwise. */
    callbackServer: CallbackServer | null = null;
    /** The shared cross-process mutex coordinator (always set after `buildDeps`). */
    lock: LockCoordinator | null = null;
    /** The currently-held lock handle, if any. Null when no critical section is open. */
    lockHandle: LockHandle | null = null;

    /**
     * Best-effort parallel cleanup of bridge, callbackServer, and lock handle.
     *
     * Each step is independently safe to call when the field is null,
     * and lock release failures are swallowed (the `proper-lockfile`
     * `signal-exit` hook is the second-chance safety net per Req 4).
     */
    async cleanup(): Promise<void> {
        const bridgeStop = this.bridge ? this.bridge.shutdown() : Promise.resolve();
        const serverStop = this.callbackServer
            ? this.callbackServer.stop()
            : Promise.resolve();
        const lockRelease =
            this.lock && this.lockHandle
                ? this.lock.release(this.lockHandle).catch(() => undefined)
                : Promise.resolve();
        await Promise.allSettled([bridgeStop, serverStop, lockRelease]);
    }
}
