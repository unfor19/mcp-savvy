/**
 * Unit tests for the Windows Credential Manager backend.
 */

import { describe, it, expect } from 'vitest';
import { WindowsCredentialManager } from './windows.js';
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
    it('is true on win32', () => {
        const k = new WindowsCredentialManager({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'win32',
        });
        expect(k.isAvailable()).toBe(true);
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
    it('invokes powershell with CredentialManager and returns the trimmed value', () => {
        const r = recordingRunner();
        r.setRunImpl(() => 'hunter2\n');
        const k = new WindowsCredentialManager({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'win32',
            runner: r.runner,
        });
        expect(k.get()).toBe('hunter2');
        expect(r.calls[0]?.cmd).toBe('powershell');
        const script = r.calls[0]?.args[2] as string;
        expect(script).toContain('CredentialManager');
        expect(script).toContain(SERVICE);
    });

    it('returns null when the value is empty', () => {
        const r = recordingRunner();
        r.setRunImpl(() => '   \n');
        const k = new WindowsCredentialManager({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'win32',
            runner: r.runner,
        });
        expect(k.get()).toBeNull();
    });

    it('returns null when powershell errors (module missing)', () => {
        const r = recordingRunner();
        r.setRunImpl(() => {
            throw new Error('module not found');
        });
        const k = new WindowsCredentialManager({
            service: SERVICE,
            account: ACCOUNT,
            platform: 'win32',
            runner: r.runner,
        });
        expect(k.get()).toBeNull();
    });

    it('keeps PowerShell metacharacters inside the credential target literal', () => {
        const r = recordingRunner();
        const service = "mcp-savvy/x'; Start-Process calc; #`$()\nnext";
        const k = new WindowsCredentialManager({
            service,
            account: ACCOUNT,
            platform: 'win32',
            runner: r.runner,
        });

        expect(k.get()).toBeNull();
        const script = r.calls[0]?.args[2] as string;
        expect(script).toContain("-Target 'mcp-savvy/x''; Start-Process calc; #`$()\nnext'");
        expect(script).not.toContain("-Target 'mcp-savvy/x'; Start-Process");
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
