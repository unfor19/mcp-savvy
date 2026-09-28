/**
 * Auto-resolving token store: keychain when available, encrypted file
 * otherwise. Migrates between backends transparently when the
 * preferred one becomes available.
 */

import type { Logger, TokenData } from '@mcp-savvy/core';
import { TokenStoreError } from '@mcp-savvy/core';
import { EncryptedFileTokenStore } from './encryptedFile.js';
import { selectKeychain, type KeychainBackend } from './keychain/index.js';
import { isTokenData } from './tokenValidation.js';
import type { TokenStore, TokenStoreOptions } from './types.js';

const ACCOUNT = 'tokens';
const FILE_BACKEND_NAME = 'encrypted file';

/** Stable, safe outcome from reading a token-store backend. */
export type CredentialReadReason =
    | 'credential-found'
    | 'credential-missing'
    | 'credential-unreadable-local-entry'
    | 'credential-invalid';

/** One attempted backend read, without credential values. */
export interface BackendReadEvent {
    /** Backend that produced the outcome. */
    backend: string;
    /** Safe classification of the local read result. */
    reason: CredentialReadReason;
    /** Whether this backend supplied the returned credential. */
    selected: boolean;
}

/** Available storage backends and deterministic precedence. */
export interface TokenStoreBackendMetadata {
    /** Backends available to this store, in precedence order. */
    available: readonly string[];
    /** Backend attempted first for reads and writes. */
    preferred: string;
}

/** Receive safe backend-read classifications for diagnostic wiring. */
export type BackendReadObserver = (event: BackendReadEvent) => void;

/** Compose the keychain service name for a namespace. */
function keychainService(namespace: string): string {
    return `mcp-savvy/${namespace}`;
}

/** Internal construction options with test and diagnostic seams. */
export interface AutoTokenStoreInternalOptions extends TokenStoreOptions {
    /** Override the keychain backend. Tests pass a fake, prod leaves unset. */
    keychain?: KeychainBackend | null;
    /** Override the encrypted-file backend. Tests pass a fake, prod leaves unset. */
    file?: TokenStore;
    /** Observe only safe, token-free backend read classifications. */
    onBackendRead?: BackendReadObserver;
}

/** Token store with deterministic keychain-first fallback behavior. */
export class AutoTokenStore implements TokenStore {
    private readonly keychain: KeychainBackend | null;
    private readonly file: TokenStore;
    private readonly logger?: Logger;
    private readonly onBackendRead?: BackendReadObserver;

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
        this.onBackendRead = opts.onBackendRead;
    }

    /** Human-readable label for the preferred backend. */
    get backendName(): string {
        return this.backendMetadata.preferred;
    }

    /** Return available backends in deterministic precedence order. */
    get backendMetadata(): TokenStoreBackendMetadata {
        const available = this.keychain
            ? [this.keychain.name, FILE_BACKEND_NAME]
            : [FILE_BACKEND_NAME];
        return { available, preferred: available[0] as string };
    }

    /** Read valid tokens from keychain first, then the encrypted file. */
    async get(): Promise<TokenData | null> {
        if (this.keychain) {
            const keychainResult = this.keychain.get();
            if (keychainResult.status === 'found') {
                const decoded = decodeStoredTokens(keychainResult.value);
                if (decoded.tokens) {
                    this.emitRead(this.keychain.name, 'credential-found', true);
                    return decoded.tokens;
                }
                this.emitRead(this.keychain.name, decoded.reason, false);
            } else {
                const reason =
                    keychainResult.status === 'missing'
                        ? 'credential-missing'
                        : 'credential-unreadable-local-entry';
                this.emitRead(this.keychain.name, reason, false);
            }
        }

        const fileTokens = await this.file.get();
        if (fileTokens === null) {
            this.emitRead(FILE_BACKEND_NAME, 'credential-missing', false);
            return null;
        }
        if (!isTokenData(fileTokens)) {
            this.emitRead(FILE_BACKEND_NAME, 'credential-invalid', false);
            return null;
        }
        this.emitRead(FILE_BACKEND_NAME, 'credential-found', true);
        return fileTokens;
    }

    /** Persist keychain-first and clear a superseded file only after success. */
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

    /** Clear every populated backend and fail if any credential may remain. */
    async clear(): Promise<void> {
        const failures: unknown[] = [];
        if (this.keychain) {
            try {
                const current = this.keychain.get();
                if (current.status !== 'missing' && !this.keychain.delete()) {
                    failures.push(new Error('keychain deletion failed'));
                }
            } catch (err) {
                failures.push(err);
            }
        }
        try {
            await this.file.clear();
        } catch (err) {
            failures.push(err);
        }
        if (failures.length > 0) {
            throw new TokenStoreError(
                'TOKEN_STORE_CLEAR_FAILED',
                'one or more token storage backends could not be cleared',
                failures[0],
            );
        }
    }

    private emitRead(backend: string, reason: CredentialReadReason, selected: boolean): void {
        this.onBackendRead?.({ backend, reason, selected });
    }
}

/** Build the recommended token store for the running process. */
export function resolveTokenStore(opts: TokenStoreOptions, logger?: Logger): TokenStore {
    return new AutoTokenStore(opts, logger);
}

type DecodedTokens =
    | { tokens: TokenData; reason: 'credential-found' }
    | {
        tokens: null;
        reason: 'credential-unreadable-local-entry' | 'credential-invalid';
    };

function decodeStoredTokens(json: string): DecodedTokens {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return { tokens: null, reason: 'credential-unreadable-local-entry' };
    }
    return isTokenData(parsed)
        ? { tokens: parsed, reason: 'credential-found' }
        : { tokens: null, reason: 'credential-invalid' };
}
