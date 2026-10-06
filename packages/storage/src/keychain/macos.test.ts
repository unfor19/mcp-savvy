/**
 * Unit tests for the macOS Keychain backend (Security.framework via JXA).
 *
 * Inject a fake runner so the suite runs on any host without touching
 * the real keychain.
 */

import { describe, it, expect } from 'vitest';
import { MacOSKeychain } from './macos.js';
import { KeychainReadError } from './types.js';
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
    it('reads through Keychain Services without putting the value in argv', () => {
        const r = recordingRunner();
        r.setRunImpl(() => '{"status":"found","value":"secret-value"}\n');
        const k = new MacOSKeychain({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'darwin',
            runner: r.runner,
        });
        expect(k.get()).toEqual({ status: 'found', value: 'secret-value' });
        const call = r.calls[0];
        expect(call?.cmd).toBe('/usr/bin/osascript');
        expect(call?.args.slice(-3)).toEqual(['--', SERVICE, ACCOUNT]);
        expect(call?.args).not.toContain('secret-value');
        const scriptIndex = call?.args.indexOf('-e') ?? -1;
        const script = call?.args[scriptIndex + 1] ?? '';
        expect(script).toContain('SecItemCopyMatching');
        expect(script).toContain('errSecItemNotFound');
        expect(script).toContain('unreadable-local-entry');
        expect(script).toContain('permission-denied');
        expect(script).toContain('integrity-failure');
        expect(script).not.toContain('find-generic-password');
    });

    it('maps the documented not-found result to missing', () => {
        const r = recordingRunner();
        r.setRunImpl(() => '{"status":"missing"}\n');
        const k = new MacOSKeychain({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'darwin',
            runner: r.runner,
        });
        expect(k.get()).toEqual({ status: 'missing' });
    });

    it('maps a successfully retrieved non-UTF-8 entry to unreadable', () => {
        const r = recordingRunner();
        r.setRunImpl(() => '{"status":"unreadable-local-entry"}\n');
        const k = new MacOSKeychain({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'darwin',
            runner: r.runner,
        });
        expect(k.get()).toEqual({ status: 'unreadable-local-entry' });
    });

    it('throws a sanitized fail-closed error for command failures', () => {
        const rawPayload = 'raw-secret-error-payload';
        const r = recordingRunner();
        r.setRunImpl(() => {
            throw new Error(rawPayload);
        });
        const k = new MacOSKeychain({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'darwin',
            runner: r.runner,
        });
        try {
            k.get();
            throw new Error('expected keychain read failure');
        } catch (error) {
            expect(error).toBeInstanceOf(KeychainReadError);
            expect(String(error)).not.toContain(rawPayload);
        }
    });
});

describe('set', () => {
    it('updates in place through Keychain Services without putting the payload in argv', () => {
        const r = recordingRunner();
        const k = new MacOSKeychain({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'darwin',
            runner: r.runner,
        });
        expect(k.set('payload')).toBe(true);
        const call = r.calls[0];
        expect(call?.cmd).toBe('/usr/bin/osascript');
        expect(call?.args).not.toContain('payload');
        expect(call?.args.slice(-3)).toEqual(['--', SERVICE, ACCOUNT]);
        expect(call?.input).toBe('payload');
        const scriptIndex = call?.args.indexOf('-e') ?? -1;
        const script = call?.args[scriptIndex + 1] ?? '';
        expect(script).toContain('SecItemUpdate');
        expect(script).toContain('errSecItemNotFound');
        expect(script).toContain('SecItemAdd');
        expect(script).not.toContain('SecItemDelete');
        expect(script.indexOf('SecItemUpdate')).toBeLessThan(script.indexOf('errSecItemNotFound'));
        expect(script.indexOf('errSecItemNotFound')).toBeLessThan(script.indexOf('SecItemAdd'));
    });

    it('returns false when the write fails', () => {
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
    it('deletes through Keychain Services without reading the secret', () => {
        const r = recordingRunner();
        const k = new MacOSKeychain({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'darwin',
            runner: r.runner,
        });
        expect(k.delete()).toBe(true);
        const call = r.calls[0];
        expect(call?.cmd).toBe('/usr/bin/osascript');
        expect(call?.args.slice(-3)).toEqual(['--', SERVICE, ACCOUNT]);
        const scriptIndex = call?.args.indexOf('-e') ?? -1;
        const script = call?.args[scriptIndex + 1] ?? '';
        expect(script).toContain('SecItemDelete');
        expect(script).toContain('errSecItemNotFound');
        expect(script).not.toContain('SecItemCopyMatching');
        expect(script).not.toContain('kSecReturnData');
        expect(script).not.toContain('delete-generic-password');
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
