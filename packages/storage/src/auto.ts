/**
 * Auto-resolving token store: keychain when available, encrypted file
 * otherwise. Migrates between backends transparently when the
 * preferred one becomes available.
 */

import type { TokenData, Logger } from '@mcp-savvy/core';
import { TokenStoreError } from '@mcp-savvy/core';
import type { TokenStore, TokenStoreOptions } from './types.js';
import { EncryptedFileTokenStore } from './encryptedFile.js';
import { selectKeychain, type KeychainBackend } from './keychain/index.js';

const ACCOUNT = 'tokens';

/** Compose the keychain service name for a namespace. */
function keychainService(namespace: string): string {
    return `mcp-savvy/${namespace}`;
}

/**
 * Internal options for `AutoTokenStore`. Tests use the optional
 * `keychain` and `file` overrides to inject fakes; production code
 * passes only `TokenStoreOptions` and lets the constructor pick.
 */
export interface AutoTokenStoreInternalOptions extends TokenStoreOptions {
    /** Override the keychain backend. Tests pass a fake, prod leaves unset. */
    keychain?: KeychainBackend | null;
    /** Override the encrypted-file backend. Tests pass a fake, prod leaves unset. */
    file?: TokenStore;
}

/**
 * Token store that prefers the OS keychain, falls back to an
 * encrypted file. The fallback is constructed eagerly so the keychain
 * backend can be missing without surprising the caller.
 */
export class AutoTokenStore implements TokenStore {
    private readonly keychain: KeychainBackend | null;
    private readonly file: TokenStore;
    private readonly logger?: Logger;

    constructor(opts: AutoTokenStoreInternalOptions, logger?: Logger) {
        this.keychain =
            opts.keychain !== undefined
                ? opts.keychain
                : selectKeychain({
                    service: keychainService(opts.namespace),
                    account: ACCOUNT,
                });
        this.file = opts.file ?? new EncryptedFileTokenStore(opts);
        this.logger = logger;
    }

    /** Human-readable label for the active backend. */
    get backendName(): string {
        return this.keychain ? this.keychain.name : 'encrypted file';
    }

    /** Read tokens from keychain first, then encrypted file. */
    async get(): Promise<TokenData | null> {
        if (this.keychain) {
            const raw = this.keychain.get();
            if (raw) return parseOrNull(raw);
        }
        return this.file.get();
    }

    /**
     * Write tokens to the keychain when available; otherwise the
     * encrypted file. After a successful keychain write we proactively
     * clear any stale encrypted-file copy from a prior session.
     */
    async set(tokens: TokenData): Promise<void> {
        const json = JSON.stringify(tokens);
        if (this.keychain) {
            if (this.keychain.set(json)) {
                this.logger?.debug(`tokens persisted to ${this.keychain.name}`);
                await this.file.clear();
                return;
            }
            this.logger?.warn(
                `keychain write failed (${this.keychain.name}); falling back to encrypted file`,
            );
        }
        try {
            await this.file.set(tokens);
            this.logger?.debug('tokens persisted to encrypted file');
        } catch (cause) {
            throw new TokenStoreError(
                'TOKEN_STORE_WRITE_FAILED',
                'all token storage backends failed to persist tokens',
                cause,
            );
        }
    }

    /** Clear from both backends so we never serve stale data. */
    async clear(): Promise<void> {
        if (this.keychain) this.keychain.delete();
        await this.file.clear();
    }
}

/**
 * Build the recommended `TokenStore` for the running process. This is
 * the function the CLI calls; library consumers can also invoke it
 * directly when they want the same defaults.
 */
export function resolveTokenStore(opts: TokenStoreOptions, logger?: Logger): TokenStore {
    return new AutoTokenStore(opts, logger);
}

/** JSON.parse but returns null on any failure (including non-object). */
function parseOrNull(json: string): TokenData | null {
    try {
        const parsed = JSON.parse(json);
        if (parsed && typeof parsed === 'object') return parsed as TokenData;
        return null;
    } catch {
        return null;
    }
}
