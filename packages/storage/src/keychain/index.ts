/**
 * Selects the right keychain backend for the current platform.
 */

import type { KeychainBackend, KeychainBackendOptions } from './types.js';
import { MacOSKeychain } from './macos.js';
import { WindowsCredentialManager } from './windows.js';
import { LinuxSecretService } from './linux.js';
import type { Runner } from '../runner.js';

export type { KeychainBackend, KeychainBackendOptions } from './types.js';
export type { Runner, RunResult } from '../runner.js';
export { nodeRunner } from '../runner.js';
export { MacOSKeychain } from './macos.js';
export { WindowsCredentialManager } from './windows.js';
export { LinuxSecretService } from './linux.js';

/** Optional overrides for `selectKeychain`. Tests pass these; prod doesn't. */
export interface SelectKeychainOverrides {
    /** Override `process.platform`. Tests pass to force a specific backend. */
    platform?: NodeJS.Platform;
    /** Override the subprocess runner. Tests pass a fake; prod leaves unset. */
    runner?: Runner;
}

/**
 * Probe each platform backend in priority order and return the first
 * one that reports `isAvailable() === true`. Returns `null` when no
 * keychain backend can run on this host (caller should fall back to
 * the encrypted file).
 */
export function selectKeychain(
    opts: KeychainBackendOptions,
    overrides: SelectKeychainOverrides = {},
): KeychainBackend | null {
    const init = { ...opts, ...overrides };
    const candidates: KeychainBackend[] = [
        new MacOSKeychain(init),
        new WindowsCredentialManager(init),
        new LinuxSecretService(init),
    ];
    for (const backend of candidates) {
        if (backend.isAvailable()) return backend;
    }
    return null;
}
