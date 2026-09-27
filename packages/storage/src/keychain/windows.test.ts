/**
 * Unit tests for the Windows Credential Manager backend.
 */

import { describe, it, expect } from 'vitest';
import { WindowsCredentialManager } from './windows.js';
import { KeychainReadError } from './types.js';
import type { Runner } from '../runner.js';

const SERVICE = 'mcp-savvy/test';
const ACCOUNT = 'tokens';

interface RecordingRunner {
    runner: Runner;
    calls: { cmd: string; args: readonly string[]; input?: string }[];
    setRunImpl(fn: (cmd: string, args: readonly string[]) => string): void;
}

function recordingRunner(): RecordingRunner {
    const calls: { cmd: string; args: readonly string[]; input?: string }[] = [];
    const state = { runImpl: (_c: string, _a: readonly string[]) => '' };
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
        setRunImpl(fn) {
            state.runImpl = fn;
        },
    };
}

describe('isAvailable', () => {
    it('is true on win32 when the reader module is available', () => {
        const r = recordingRunner();
        const k = new WindowsCredentialManager({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'win32',
            runner: r.runner,
        });
        expect(k.isAvailable()).toBe(true);
        expect(r.calls[0]?.cmd).toBe('powershell');
        expect(r.calls[0]?.args.at(-1)).toContain('Import-Module CredentialManager');
    });

    it('is false on win32 when the reader module is unavailable', () => {
        const r = recordingRunner();
        r.setRunImpl(() => {
            throw new Error('module unavailable');
        });
        const k = new WindowsCredentialManager({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'win32',
            runner: r.runner,
        });
        expect(k.isAvailable()).toBe(false);
    });

    it('is false elsewhere', () => {
        const k = new WindowsCredentialManager({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'darwin',
        });
        expect(k.isAvailable()).toBe(false);
    });
});

describe('get', () => {
    it('invokes PowerShell with CredentialManager and returns the value', () => {
        const r = recordingRunner();
        r.setRunImpl(() => '{"status":"found","value":"hunter2"}\n');
        const k = new WindowsCredentialManager({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'win32',
            runner: r.runner,
        });
        expect(k.get()).toEqual({ status: 'found', value: 'hunter2' });
        expect(r.calls[0]?.cmd).toBe('powershell');
        const script = r.calls[0]?.args.at(-1) as string;
        expect(script).toContain('CredentialManager');
        expect(script).toContain(SERVICE);
        expect(script).toContain("status = 'missing'");
        expect(script).toContain("status = 'unreadable-local-entry'");
        expect(script).toContain("category = 'permission-denied'");
        expect(script).toContain("category = 'integrity-failure'");
    });

    it('maps the documented absent result to missing', () => {
        const r = recordingRunner();
        r.setRunImpl(() => '{"status":"missing"}');
        const k = new WindowsCredentialManager({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'win32',
            runner: r.runner,
        });
        expect(k.get()).toEqual({ status: 'missing' });
    });

    it('maps a retrieved but undecodable entry to unreadable', () => {
        const r = recordingRunner();
        r.setRunImpl(() => '{"status":"unreadable-local-entry"}');
        const k = new WindowsCredentialManager({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'win32',
            runner: r.runner,
        });
        expect(k.get()).toEqual({ status: 'unreadable-local-entry' });
    });

    it('fails closed when the CredentialManager module cannot be invoked', () => {
        const r = recordingRunner();
        r.setRunImpl(() => '{"status":"error","category":"invocation-failure"}');
        const k = new WindowsCredentialManager({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'win32',
            runner: r.runner,
        });
        expect(() => k.get()).toThrowError(KeychainReadError);
    });

    it('does not disclose raw command error payloads', () => {
        const rawPayload = 'raw-secret-error-payload';
        const r = recordingRunner();
        r.setRunImpl(() => {
            throw new Error(rawPayload);
        });
        const k = new WindowsCredentialManager({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'win32',
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

    it('keeps PowerShell metacharacters inside the credential target literal', () => {
        const r = recordingRunner();
        r.setRunImpl(() => '{"status":"missing"}');
        const service = "mcp-savvy/x'; Start-Process calc; #`$()\nnext";
        const k = new WindowsCredentialManager({
            service,
            account: ACCOUNT,
            platform: 'win32',
            runner: r.runner,
        });

        expect(k.get()).toEqual({ status: 'missing' });
        const script = r.calls[0]?.args.at(-1) as string;
        expect(script).toContain("$target = 'mcp-savvy/x''; Start-Process calc; #`$()\nnext';");
        expect(script).not.toContain("$target = 'mcp-savvy/x'; Start-Process");
    });
});

describe('set', () => {
    it('passes credential data only over stdin to a static PowerShell program', () => {
        const r = recordingRunner();
        const k = new WindowsCredentialManager({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'win32',
            runner: r.runner,
        });
        expect(k.set('value')).toBe(true);
        expect(r.calls[0]?.cmd).toBe('powershell');
        const args = r.calls[0]?.args ?? [];
        expect(args.join(' ')).not.toContain(SERVICE);
        expect(args.join(' ')).not.toContain('value');
        expect(r.calls[0]?.input).toBe(
            JSON.stringify({ target: SERVICE, username: ACCOUNT, password: 'value' }),
        );
    });

    it('returns false when cmdkey errors', () => {
        const r = recordingRunner();
        r.runner.runWithStdin = () => ({ status: 1 });
        const k = new WindowsCredentialManager({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'win32',
            runner: r.runner,
        });
        expect(k.set('v')).toBe(false);
    });
});

describe('delete', () => {
    it('returns true on success', () => {
        const r = recordingRunner();
        const k = new WindowsCredentialManager({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'win32',
            runner: r.runner,
        });
        expect(k.delete()).toBe(true);
    });

    it('returns false on failure', () => {
        const r = recordingRunner();
        r.setRunImpl(() => {
            throw new Error('not found');
        });
        const k = new WindowsCredentialManager({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'win32',
            runner: r.runner,
        });
        expect(k.delete()).toBe(false);
    });
});
