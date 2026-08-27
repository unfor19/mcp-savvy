/**
 * Tests for `selectKeychain`: should pick the right backend per
 * platform, or return null when none is available.
 */

import { describe, it, expect } from 'vitest';
import { selectKeychain } from './index.js';
import type { Runner } from '../runner.js';

const ALWAYS_OK_RUNNER: Runner = {
    run: () => '',
    runWithStdin: () => ({ status: 0 }),
};

const ALWAYS_FAIL_RUNNER: Runner = {
    run: () => {
        throw new Error('not found');
    },
    runWithStdin: () => ({ status: 1 }),
};

describe('selectKeychain', () => {
    it('returns the macOS backend on darwin', () => {
        const k = selectKeychain(
            { service: 's', account: 'a' },
            { platform: 'darwin', runner: ALWAYS_OK_RUNNER },
        );
        expect(k?.name).toBe('macOS Keychain');
    });

    it('returns the Windows backend on win32', () => {
        const k = selectKeychain(
            { service: 's', account: 'a' },
            { platform: 'win32', runner: ALWAYS_OK_RUNNER },
        );
        expect(k?.name).toBe('Windows Credential Manager');
    });

    it('returns the Linux backend on linux when secret-tool is present', () => {
        const k = selectKeychain(
            { service: 's', account: 'a' },
            { platform: 'linux', runner: ALWAYS_OK_RUNNER },
        );
        expect(k?.name).toBe('Linux Secret Service');
    });

    it('returns null on linux when secret-tool is missing', () => {
        const k = selectKeychain(
            { service: 's', account: 'a' },
            { platform: 'linux', runner: ALWAYS_FAIL_RUNNER },
        );
        expect(k).toBeNull();
    });

    it('returns null on an unknown platform', () => {
        const k = selectKeychain(
            { service: 's', account: 'a' },
            { platform: 'freebsd' as NodeJS.Platform, runner: ALWAYS_OK_RUNNER },
        );
        expect(k).toBeNull();
    });
});
