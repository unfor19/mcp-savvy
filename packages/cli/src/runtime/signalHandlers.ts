/**
 * Module-load signal handlers with deadline-bounded shutdown.
 *
 * Installs handlers for `SIGINT`, `SIGTERM`, `SIGHUP`, and
 * `uncaughtException` at module import time. Each handler calls
 * `Cli.cleanup()` under a hard deadline read from
 * `MCP_SAVVY_SHUTDOWN_DEADLINE_MS`, then forces `process.exit` with a
 * signal-appropriate code.
 *
 * Behavior contract (Requirement 4):
 *  - A second signal during cleanup is ignored (Req 4.5).
 *  - Shutdown is preempted when the deadline elapses (Req 4.6).
 *  - Exit codes: SIGINT → 130, SIGTERM → 143, SIGHUP → 129,
 *    uncaughtException → 1 (Req 4.1–4.4, 4.7).
 *  - `proper-lockfile`'s built-in `signal-exit` hook is the safety
 *    net for `SIGKILL` and other force-exit paths (Req 4.8).
 *
 * The handler reads the deadline without throwing: a malformed or
 * out-of-range `MCP_SAVVY_SHUTDOWN_DEADLINE_MS` falls back to the
 * default. Signal handlers run after `loadConfig` may have already
 * thrown, so they cannot rely on validated config.
 */

import {
    DEFAULT_SHUTDOWN_DEADLINE_MS,
    SHUTDOWN_DEADLINE_MAX_MS,
    SHUTDOWN_DEADLINE_MIN_MS,
} from '../env.js';
import type { Cli } from './cliRuntime.js';

/** The live runtime that the signal handlers will shut down. Set by `main`. */
let cliInstance: Cli | null = null;

/** Latch flipped on the first signal so a second signal is a no-op (Req 4.5). */
let shuttingDown = false;

/** Wire the live `Cli` runtime so the installed handlers can clean it up. */
export function setCliInstance(cli: Cli | null): void {
    cliInstance = cli;
}

/** Return the currently-registered `Cli` runtime (visible for tests). */
export function getCliInstance(): Cli | null {
    return cliInstance;
}

/** Return whether the shutdown latch has been flipped (visible for tests). */
export function isShuttingDown(): boolean {
    return shuttingDown;
}

/** Reset the shutdown latch (test-only seam for 7.3). */
export function resetShutdownLatchForTests(): void {
    shuttingDown = false;
}

/**
 * Read the shutdown deadline without throwing.
 *
 * Falls back to the default on missing, malformed, non-numeric, or
 * out-of-range input — module-load signal handlers must never fail.
 * The validating path (which throws on bad input) lives in
 * `loadConfig` and runs from inside `main`.
 */
function getShutdownDeadlineMs(env: NodeJS.ProcessEnv): number {
    const raw = env['MCP_SAVVY_SHUTDOWN_DEADLINE_MS'];
    if (raw === undefined) return DEFAULT_SHUTDOWN_DEADLINE_MS;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return DEFAULT_SHUTDOWN_DEADLINE_MS;
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(n) || String(n) !== trimmed) return DEFAULT_SHUTDOWN_DEADLINE_MS;
    if (n < SHUTDOWN_DEADLINE_MIN_MS || n > SHUTDOWN_DEADLINE_MAX_MS) {
        return DEFAULT_SHUTDOWN_DEADLINE_MS;
    }
    return n;
}

/** Exit-code mapping for the three handled termination signals (Req 4.1–4.3). */
const SIGNAL_EXIT_CODES: Record<'SIGINT' | 'SIGTERM' | 'SIGHUP', number> = {
    SIGINT: 130,
    SIGTERM: 143,
    SIGHUP: 129,
};

/**
 * Run `Cli.cleanup()` under a hard deadline, then `process.exit`.
 *
 * The deadline (`MCP_SAVVY_SHUTDOWN_DEADLINE_MS`) is enforced via
 * `Promise.race` so a stuck cleanup never wedges the process. The
 * timer is `unref`'d so it doesn't keep the event loop alive on its
 * own (Req 4.6).
 */
async function runShutdown(exitCode: number): Promise<void> {
    const deadlineMs = getShutdownDeadlineMs(process.env);
    const cleanup = cliInstance ? cliInstance.cleanup() : Promise.resolve();
    const deadline = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, deadlineMs);
        t.unref();
    });
    await Promise.race([cleanup, deadline]);
    process.exit(exitCode);
}

/** Handle a termination signal: latch, then run bounded shutdown. */
export function onSignal(sig: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): void {
    if (shuttingDown) return;
    shuttingDown = true;
    void runShutdown(SIGNAL_EXIT_CODES[sig]);
}

/** Handle an uncaught exception: log to stderr, then run bounded shutdown with code 1. */
export function onUncaughtException(err: Error): void {
    if (shuttingDown) return;
    shuttingDown = true;
    // Log to stderr; never stdout (MCP JSON-RPC discipline — Req 9.5).
    process.stderr.write(`uncaught: ${err.message}\n`);
    void runShutdown(1);
}

process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGHUP', () => onSignal('SIGHUP'));
process.on('uncaughtException', onUncaughtException);
