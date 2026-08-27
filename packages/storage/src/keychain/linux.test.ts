/**
 * Unit tests for the Linux Secret Service backend.
 */

import { describe, it, expect } from 'vitest';
import { LinuxSecretService } from './linux.js';
import type { Runner, RunResult } from '../runner.js';

const SERVICE = 'mcp-savvy/test';
const ACCOUNT = 'tokens';

interface RecordingRunner {
    runner: Runner;
    runCalls: { cmd: string; args: readonly string[] }[];
    stdinCalls: { cmd: string; args: readonly string[]; input: string }[];
    setRunImpl(fn: (cmd: string, args: readonly string[]) => string): void;
    setStdinImpl(fn: (cmd: string, args: readonly string[], input: string) => RunResult): void;
}

function recordingRunner(): RecordingRunner {
    const runCalls: { cmd: string; args: readonly string[] }[] = [];
    const stdinCalls: { cmd: string; args: readonly string[]; input: string }[] = [];
    const state = {
        runImpl: (_c: string, _a: readonly string[]) => '',
        stdinImpl: (_c: string, _a: readonly string[], _i: string): RunResult => ({ status: 0 }),
    };
    return {
        runner: {
            run(cmd, args) {
                runCalls.push({ cmd, args });
                return state.runImpl(cmd, args);
            },
            runWithStdin(cmd, args, input) {
                stdinCalls.push({ cmd, args, input });
                return state.stdinImpl(cmd, args, input);
            },
        },
        runCalls,
        stdinCalls,
        setRunImpl(fn) {
            state.runImpl = fn;
        },
        setStdinImpl(fn) {
            state.stdinImpl = fn;
        },
    };
}

describe('isAvailable', () => {
    it('is false on non-linux', () => {
        const k = new LinuxSecretService({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'darwin',
        });
        expect(k.isAvailable()).toBe(false);
    });

    it('is true on linux when secret-tool is on PATH', () => {
        const r = recordingRunner();
        const k = new LinuxSecretService({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'linux',
            runner: r.runner,
        });
        expect(k.isAvailable()).toBe(true);
    });

    it('is false on linux when secret-tool is missing', () => {
        const r = recordingRunner();
        r.setRunImpl(() => {
            throw new Error('not found');
        });
        const k = new LinuxSecretService({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'linux',
            runner: r.runner,
        });
        expect(k.isAvailable()).toBe(false);
    });
});

describe('get', () => {
    it('invokes secret-tool lookup with service+account args', () => {
        const r = recordingRunner();
        r.setRunImpl(() => 'payload\n');
        const k = new LinuxSecretService({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'linux',
            runner: r.runner,
        });
        expect(k.get()).toBe('payload');
        const lookup = r.runCalls.find((c) => c.args[0] === 'lookup');
        expect(lookup?.cmd).toBe('secret-tool');
        expect(lookup?.args).toEqual(['lookup', 'service', SERVICE, 'account', ACCOUNT]);
    });

    it('returns null on empty output', () => {
        const r = recordingRunner();
        r.setRunImpl(() => '\n');
        const k = new LinuxSecretService({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'linux',
            runner: r.runner,
        });
        expect(k.get()).toBeNull();
    });

    it('returns null when secret-tool errors', () => {
        const r = recordingRunner();
        r.setRunImpl(() => {
            throw new Error('locked');
        });
        const k = new LinuxSecretService({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'linux',
            runner: r.runner,
        });
        expect(k.get()).toBeNull();
    });
});

describe('set', () => {
    it('pipes the secret via stdin (not argv)', () => {
        const r = recordingRunner();
        const k = new LinuxSecretService({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'linux',
            runner: r.runner,
        });
        expect(k.set('hush')).toBe(true);
        expect(r.stdinCalls).toHaveLength(1);
        const call = r.stdinCalls[0]!;
        expect(call.cmd).toBe('secret-tool');
        expect(call.args[0]).toBe('store');
        // Crucially: the secret is not in argv.
        expect(call.args).not.toContain('hush');
        expect(call.input).toBe('hush');
    });

    it('returns false when spawnSync exits non-zero', () => {
        const r = recordingRunner();
        r.setStdinImpl(() => ({ status: 1 }));
        const k = new LinuxSecretService({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'linux',
            runner: r.runner,
        });
        expect(k.set('v')).toBe(false);
    });
});

describe('delete', () => {
    it('returns true on success', () => {
        const r = recordingRunner();
        const k = new LinuxSecretService({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'linux',
            runner: r.runner,
        });
        expect(k.delete()).toBe(true);
    });

    it('returns false on failure', () => {
        const r = recordingRunner();
        let n = 0;
        r.setRunImpl(() => {
            n += 1;
            // First call is `which secret-tool` from constructor-less init; we
            // only need it to throw on the `clear` path. Here, no constructor
            // call occurs (we don't call isAvailable), so the first call IS clear.
            throw new Error('not found');
            // (kept simple: every call fails)
        });
        const k = new LinuxSecretService({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'linux',
            runner: r.runner,
        });
        expect(k.delete()).toBe(false);
    });
});
