/**
 * Unit tests for the macOS Keychain backend (`security` CLI).
 *
 * Inject a fake runner so the suite runs on any host without touching
 * the real keychain.
 */

import { describe, it, expect } from 'vitest';
import { MacOSKeychain } from './macos.js';
import type { Runner } from '../runner.js';

const SERVICE = 'mcp-savvy/test';
const ACCOUNT = 'tokens';

/** Build a runner that records every call and yields scripted results. */
function recordingRunner(): {
    runner: Runner;
    calls: { cmd: string; args: readonly string[]; input?: string }[];
    runImpl: (cmd: string, args: readonly string[]) => string;
    setRunImpl(fn: (cmd: string, args: readonly string[]) => string): void;
} {
    const calls: { cmd: string; args: readonly string[]; input?: string }[] = [];
    const state = {
        runImpl: (_c: string, _a: readonly string[]) => '',
    };
    return {
        runner: {
            run(cmd, args) {
                calls.push({ cmd, args });
                return state.runImpl(cmd, args);
            },
            runWithStdin(cmd, args, input) {
                calls.push({ cmd, args, input });
                return { status: 0 };
            },
        },
        calls,
        get runImpl() {
            return state.runImpl;
        },
        setRunImpl(fn) {
            state.runImpl = fn;
        },
    };
}

describe('isAvailable', () => {
    it('is true on darwin', () => {
        const k = new MacOSKeychain({ service: SERVICE, account: ACCOUNT, platform: 'darwin' });
        expect(k.isAvailable()).toBe(true);
    });

    it('is false on linux', () => {
        const k = new MacOSKeychain({ service: SERVICE, account: ACCOUNT, platform: 'linux' });
        expect(k.isAvailable()).toBe(false);
    });
});

describe('get', () => {
    it('invokes `security find-generic-password -w` and trims trailing newline', () => {
        const r = recordingRunner();
        r.setRunImpl(() => 'secret-value\n');
        const k = new MacOSKeychain({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'darwin',
            runner: r.runner,
        });
        expect(k.get()).toBe('secret-value');
        expect(r.calls[0]?.cmd).toBe('security');
        expect(r.calls[0]?.args).toEqual([
            'find-generic-password',
            '-s',
            SERVICE,
            '-a',
            ACCOUNT,
            '-w',
        ]);
    });

    it('returns null when the entry is absent (CLI throws)', () => {
        const r = recordingRunner();
        r.setRunImpl(() => {
            throw new Error('not found');
        });
        const k = new MacOSKeychain({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'darwin',
            runner: r.runner,
        });
        expect(k.get()).toBeNull();
    });
});

describe('set', () => {
    it('writes through Keychain Services without putting the payload in argv', () => {
        const r = recordingRunner();
        const k = new MacOSKeychain({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'darwin',
            runner: r.runner,
        });
        expect(k.set('payload')).toBe(true);
        expect(r.calls[0]?.cmd).toBe('/usr/bin/osascript');
        expect(r.calls[0]?.args).not.toContain('payload');
        expect(r.calls[0]?.args).toContain(SERVICE);
        expect(r.calls[0]?.args).toContain(ACCOUNT);
        expect(r.calls[0]?.input).toBe('payload');
    });

    it('returns false when the add fails', () => {
        const r = recordingRunner();
        r.runner.runWithStdin = () => ({ status: 1 });
        const k = new MacOSKeychain({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'darwin',
            runner: r.runner,
        });
        expect(k.set('payload')).toBe(false);
    });
});

describe('delete', () => {
    it('returns true on success', () => {
        const r = recordingRunner();
        const k = new MacOSKeychain({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'darwin',
            runner: r.runner,
        });
        expect(k.delete()).toBe(true);
    });

    it('returns false on failure', () => {
        const r = recordingRunner();
        r.setRunImpl(() => {
            throw new Error('not found');
        });
        const k = new MacOSKeychain({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'darwin',
            runner: r.runner,
        });
        expect(k.delete()).toBe(false);
    });
});
