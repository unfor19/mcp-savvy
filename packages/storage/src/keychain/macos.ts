/**
 * macOS Keychain backend via the `security` CLI.
 *
 * No native dependency: we shell out to the system tool that ships
 * with macOS, so `npx mcp-savvy` works without node-gyp.
 */

import { platform } from 'node:os';
import type { KeychainBackend, KeychainBackendOptions } from './types.js';
import { nodeRunner, type Runner } from '../runner.js';

/** Constructor options for `MacOSKeychain`. */
export interface MacOSKeychainOptions extends KeychainBackendOptions {
    /** Override the subprocess runner. Tests pass a fake; prod leaves unset. */
    runner?: Runner;
    /** Override `process.platform`. Tests pass 'darwin'; prod leaves unset. */
    platform?: NodeJS.Platform;
}

/** macOS implementation of `KeychainBackend`. */
export class MacOSKeychain implements KeychainBackend {
    readonly name = 'macOS Keychain';
    private readonly service: string;
    private readonly account: string;
    private readonly runner: Runner;
    private readonly currentPlatform: NodeJS.Platform;

    constructor(opts: MacOSKeychainOptions) {
        this.service = opts.service;
        this.account = opts.account;
        this.runner = opts.runner ?? nodeRunner;
        this.currentPlatform = opts.platform ?? platform();
    }

    /** True only on Darwin; the `security` binary ships with the OS. */
    isAvailable(): boolean {
        return this.currentPlatform === 'darwin';
    }

    /** Read the password for our service+account, or null if not set. */
    get(): string | null {
        try {
            const out = this.runner.run('security', [
                'find-generic-password',
                '-s',
                this.service,
                '-a',
                this.account,
                '-w',
            ]);
            return out.replace(/\n$/, '');
        } catch {
            return null;
        }
    }

    /** Replace any existing entry. Returns true on success. */
    set(value: string): boolean {
        // Delete first to avoid the "already exists" error path.
        try {
            this.runner.run('security', [
                'delete-generic-password',
                '-s',
                this.service,
                '-a',
                this.account,
            ]);
        } catch {
            // Absent entry is fine.
        }
        try {
            const result = this.runner.runWithStdin('security', [
                'add-generic-password',
                '-s',
                this.service,
                '-a',
                this.account,
                '-w',
            ], `${value}\n`);
            return result.status === 0;
        } catch {
            return false;
        }
    }

    /** Best-effort delete; returns true if the entry was removed. */
    delete(): boolean {
        try {
            this.runner.run('security', [
                'delete-generic-password',
                '-s',
                this.service,
                '-a',
                this.account,
            ]);
            return true;
        } catch {
            return false;
        }
    }
}
