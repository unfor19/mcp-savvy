/**
 * Unit tests for the module-level signal handlers and bounded shutdown.
 *
 * Covers Requirement 4 (signal-driven cleanup):
 *  - 4.1–4.4: each entrypoint maps to its expected exit code.
 *  - 4.5: a second signal during cleanup is a no-op.
 *  - 4.6: cleanup that exceeds `MCP_SAVVY_SHUTDOWN_DEADLINE_MS` is
 *    preempted, and the signal's exit code is still honored.
 *  - 4.7: `uncaughtException` exits with code 1.
 *
 * The tests drive the handler functions directly (rather than
 * `process.emit`) so vitest's own SIGINT and uncaughtException
 * listeners cannot interfere. They override `process.exit` via
 * direct property assignment (not `vi.spyOn`) because vitest
 * installs its own throwing wrapper at worker startup; a direct
 * assignment is the simplest way to keep our handler installed
 * across `await` boundaries.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Cli } from './cliRuntime.js';
import {
    onSignal,
    onUncaughtException,
    resetShutdownLatchForTests,
    setCliInstance,
} from './signalHandlers.js';

/** Stub `Cli` whose `cleanup()` resolves after a configurable delay. */
class StubCli extends Cli {
    cleanupCalls = 0;
    constructor(private readonly delayMs: number) {
        super();
    }
    override async cleanup(): Promise<void> {
        this.cleanupCalls += 1;
        if (this.delayMs <= 0) return;
        await new Promise<void>((resolve) => {
            setTimeout(resolve, this.delayMs);
        });
    }
}

interface ExitCapture {
    calls: number[];
    waitForExit: () => Promise<number>;
}

let originalExit: typeof process.exit | null = null;

/** Replace `process.exit` with a recording stub and expose a wait-for-call promise. */
function captureExit(): ExitCapture {
    const calls: number[] = [];
    let resolveExit!: (code: number) => void;
    const exitPromise = new Promise<number>((resolve) => {
        resolveExit = resolve;
    });
    originalExit = process.exit;
    process.exit = ((code?: number | string | null) => {
        const c = typeof code === 'number' ? code : 0;
        calls.push(c);
        if (calls.length === 1) resolveExit(c);
        return undefined as never;
    }) as typeof process.exit;
    return { calls, waitForExit: () => exitPromise };
}

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    resetShutdownLatchForTests();
    setCliInstance(null);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
    setCliInstance(null);
    resetShutdownLatchForTests();
    if (originalExit !== null) {
        process.exit = originalExit;
        originalExit = null;
    }
    stderrSpy.mockRestore();
});

describe('signal handlers — idempotent shutdown (Req 4.5)', () => {
    it('ignores a second SIGINT while cleanup is still in flight', async () => {
        const cli = new StubCli(30);
        setCliInstance(cli);
        const { calls, waitForExit } = captureExit();

        onSignal('SIGINT');
        // Second signal arrives synchronously while cleanup is pending.
        onSignal('SIGINT');

        const code = await waitForExit();
        expect(code).toBe(130);
        expect(calls).toEqual([130]);
        expect(cli.cleanupCalls).toBe(1);
    });
});

describe('signal handlers — deadline-bounded shutdown (Req 4.6)', () => {
    it('preempts a stuck cleanup at the deadline and still honors the exit code', async () => {
        const original = process.env['MCP_SAVVY_SHUTDOWN_DEADLINE_MS'];
        process.env['MCP_SAVVY_SHUTDOWN_DEADLINE_MS'] = '100';
        try {
            // Cleanup takes far longer than the deadline; deadline must win.
            const cli = new StubCli(2_000);
            setCliInstance(cli);
            const { calls, waitForExit } = captureExit();

            const start = Date.now();
            onSignal('SIGINT');
            const code = await waitForExit();
            const elapsed = Date.now() - start;

            expect(code).toBe(130);
            expect(calls).toEqual([130]);
            // Deadline is 100ms; allow CI slack but stay well below cleanup's 2_000ms.
            expect(elapsed).toBeLessThan(1_000);
        } finally {
            if (original === undefined) {
                delete process.env['MCP_SAVVY_SHUTDOWN_DEADLINE_MS'];
            } else {
                process.env['MCP_SAVVY_SHUTDOWN_DEADLINE_MS'] = original;
            }
        }
    });
});

describe('signal handlers — exit-code matrix (Req 4.1–4.4, 4.7)', () => {
    it.each<[Parameters<typeof onSignal>[0], number]>([
        ['SIGINT', 130],
        ['SIGTERM', 143],
        ['SIGHUP', 129],
    ])('exits with %i on %s', async (sig, expected) => {
        const cli = new StubCli(0);
        setCliInstance(cli);
        const { calls, waitForExit } = captureExit();

        onSignal(sig);
        const code = await waitForExit();

        expect(code).toBe(expected);
        expect(calls).toEqual([expected]);
    });

    it('exits with 1 on uncaughtException and logs the error to stderr', async () => {
        const cli = new StubCli(0);
        setCliInstance(cli);
        const { calls, waitForExit } = captureExit();

        onUncaughtException(new Error('boom'));
        const code = await waitForExit();

        expect(code).toBe(1);
        expect(calls).toEqual([1]);
        // Handler writes the failure to stderr — never stdout (Req 9.5).
        const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
        expect(stderrOutput).toContain('boom');
    });
});
