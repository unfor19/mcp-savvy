/**
 * Linux Secret Service backend via the `secret-tool` CLI (libsecret).
 *
 * Available on most desktop distros via gnome-keyring or kwallet.
 * Headless and minimal Linux installs typically lack `secret-tool`,
 * in which case `isAvailable()` returns false and the resolver picks
 * the encrypted-file fallback.
 */

import { platform } from 'node:os';
import type { KeychainBackend, KeychainBackendOptions } from './types.js';
import { nodeRunner, type Runner } from '../runner.js';

/** Constructor options for `LinuxSecretService`. */
export interface LinuxSecretServiceOptions extends KeychainBackendOptions {
    /** Override the subprocess runner. Tests pass a fake; prod leaves unset. */
    runner?: Runner;
    /** Override `process.platform`. Tests pass 'linux'; prod leaves unset. */
    platform?: NodeJS.Platform;
}

/** Linux implementation of `KeychainBackend`. */
export class LinuxSecretService implements KeychainBackend {
    readonly name = 'Linux Secret Service';
    private readonly service: string;
    private readonly account: string;
    private readonly runner: Runner;
    private readonly currentPlatform: NodeJS.Platform;

    constructor(opts: LinuxSecretServiceOptions) {
        this.service = opts.service;
        this.account = opts.account;
        this.runner = opts.runner ?? nodeRunner;
        this.currentPlatform = opts.platform ?? platform();
    }

    /** Available only when both Linux and `secret-tool` are present. */
    isAvailable(): boolean {
        if (this.currentPlatform !== 'linux') return false;
        try {
            this.runner.run('which', ['secret-tool']);
            return true;
        } catch {
            return false;
        }
    }

    /** Read via `secret-tool lookup`. */
    get(): string | null {
        try {
            const out = this.runner.run('secret-tool', [
                'lookup',
                'service',
                this.service,
                'account',
                this.account,
            ]);
            const trimmed = out.replace(/\n$/, '');
            return trimmed.length > 0 ? trimmed : null;
        } catch {
            return null;
        }
    }

    /**
     * Write via `secret-tool store`. The CLI reads the secret from
     * stdin so we pipe it without exposing the value on argv (which
     * would leak via `ps`).
     */
    set(value: string): boolean {
        const result = this.runner.runWithStdin(
            'secret-tool',
            ['store', '--label', this.service, 'service', this.service, 'account', this.account],
            value,
        );
        return result.status === 0;
    }

    /** Clear via `secret-tool clear`. */
    delete(): boolean {
        try {
            this.runner.run('secret-tool', [
                'clear',
                'service',
                this.service,
                'account',
                this.account,
            ]);
            return true;
        } catch {
            return false;
        }
    }
}
