/**
 * Example-based tests for LockCoordinator covering config validation,
 * correlation-id pairing across acquire/release log records, the
 * stale-reclaim warn record's field shape, and stdout discipline
 * during the lock lifecycle. Implements task 2.5 in
 * concurrent-client-safety.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Logger } from '@mcp-savvy/core';
import { LockError } from '@mcp-savvy/core';
import { LockCoordinator } from './coordinator.js';

interface LogRecord {
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    fields?: Record<string, unknown>;
}

/** Build a logger that appends every emission to an in-memory list. */
function recordingLogger(): { records: LogRecord[]; logger: Logger } {
    const records: LogRecord[] = [];
    const emit =
        (level: LogRecord['level']) =>
            (message: string, fields?: Record<string, unknown>) => {
                records.push({ level, message, fields });
            };
    const logger: Logger = {
        debug: emit('debug'),
        info: emit('info'),
        warn: emit('warn'),
        error: emit('error'),
        child: () => logger,
    };
    return { records, logger };
}

let dataDir: string;

beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'mcp-savvy-lock-ex-'));
});

afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
});

describe('LockCoordinator (example-based)', () => {
    it('rejects staleness below 3x heartbeat with LOCK_CONFIG_INVALID', () => {
        // 2.5(a) — Requirement 2.3
        let caught: unknown;
        try {
            new LockCoordinator({
                dataDir,
                heartbeatIntervalMs: 2000,
                stalenessThresholdMs: 5000, // < 3 * 2000
            });
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(LockError);
        expect((caught as LockError).code).toBe('LOCK_CONFIG_INVALID');
        expect((caught as LockError).message).toMatch(/staleness/i);
    });

    it('emits matching correlationId on lock.acquire and lock.release', async () => {
        // 2.5(b) — Requirements 9.1, 9.2
        const { records, logger } = recordingLogger();
        const coord = new LockCoordinator({ dataDir, logger });

        const handle = await coord.acquire({
            namespace: 'ns-corr',
            timeoutMs: 5_000,
        });
        await coord.release(handle);

        const acq = records.find((r) => r.message === 'lock.acquire');
        const rel = records.find((r) => r.message === 'lock.release');
        expect(acq).toBeDefined();
        expect(rel).toBeDefined();
        expect(acq!.level).toBe('debug');
        expect(rel!.level).toBe('debug');
        expect(acq!.fields?.correlationId).toBe(handle.correlationId);
        expect(rel!.fields?.correlationId).toBe(handle.correlationId);
        expect(acq!.fields?.namespace).toBe('ns-corr');
        expect(rel!.fields?.namespace).toBe('ns-corr');
        expect(acq!.fields?.pid).toBe(process.pid);
        expect(rel!.fields?.pid).toBe(process.pid);
    });

    it('emits lock.stale-reclaim with heartbeatAgeMs and reclaiming pid', async () => {
        // 2.5(c) — Requirement 9.3
        const { records, logger } = recordingLogger();
        const heartbeatMs = 1_000;
        const stalenessMs = 3_000;
        const coord = new LockCoordinator({
            dataDir,
            heartbeatIntervalMs: heartbeatMs,
            stalenessThresholdMs: stalenessMs,
            logger,
        });

        // Plant a stale lock dir with mtime well past the staleness window.
        const locksDir = path.join(dataDir, 'locks');
        await mkdir(locksDir, { recursive: true, mode: 0o700 });
        const lockPath = path.join(locksDir, 'ns-stale.lock');
        await mkdir(lockPath, { recursive: true, mode: 0o700 });
        const stalePoint = new Date(Date.now() - 60_000);
        await utimes(lockPath, stalePoint, stalePoint);

        const handle = await coord.acquire({
            namespace: 'ns-stale',
            timeoutMs: 10_000,
        });
        try {
            const stale = records.find((r) => r.message === 'lock.stale-reclaim');
            expect(stale).toBeDefined();
            expect(stale!.level).toBe('warn');
            expect(stale!.fields?.namespace).toBe('ns-stale');
            expect(stale!.fields?.pid).toBe(process.pid);
            const age = stale!.fields?.heartbeatAgeMs;
            expect(typeof age).toBe('number');
            expect(age as number).toBeGreaterThan(stalenessMs);
        } finally {
            await coord.release(handle);
        }
    });

    it('writes zero bytes to process.stdout during a full acquire-release cycle', async () => {
        // 2.5(d) — Requirement 9.5
        const writeSpy = vi
            .spyOn(process.stdout, 'write')
            .mockImplementation(() => true);
        try {
            const coord = new LockCoordinator({ dataDir });
            const handle = await coord.acquire({
                namespace: 'ns-stdout',
                timeoutMs: 5_000,
            });
            await coord.release(handle);
            expect(writeSpy).not.toHaveBeenCalled();
        } finally {
            writeSpy.mockRestore();
        }
    });
});
