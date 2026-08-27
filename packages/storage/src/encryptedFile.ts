/**
 * AES-256-CBC encrypted file fallback for the token store.
 *
 * Used when no OS keychain is available (e.g. headless Linux without
 * libsecret). The encryption key is derived from machine-bound material
 * (hostname + username + homedir + service name) via scrypt — it is
 * NOT a security boundary against a local attacker, only a defense in
 * depth so tokens are not stored as cleartext on disk.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir as defaultHomedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { TokenData } from '@mcp-savvy/core';
import { TokenStoreError } from '@mcp-savvy/core';
import type { TokenStore, TokenStoreOptions } from './types.js';

const SERVICE_BASE = 'mcp-savvy';
const FILE_NAME = 'tokens.enc';
const KEY_LEN = 32;
const IV_LEN = 16;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Derive a 32-byte AES key from machine-bound material via scrypt. */
function deriveKey(namespace: string, home: string): Buffer {
    const machineId = `${hostname()}:${userInfo().username}:${home}:${SERVICE_BASE}:${namespace}`;
    return scryptSync(machineId, SERVICE_BASE, KEY_LEN);
}

/** Encrypt plaintext with a fresh IV; output is `iv || ciphertext`. */
function encrypt(plaintext: string, key: Buffer): Buffer {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, ciphertext]);
}

/** Reverse of `encrypt`: takes `iv || ciphertext` and returns plaintext. */
function decrypt(blob: Buffer, key: Buffer): string {
    if (blob.length <= IV_LEN) {
        throw new Error('encrypted blob too short');
    }
    const iv = blob.subarray(0, IV_LEN);
    const ciphertext = blob.subarray(IV_LEN);
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
}

/**
 * Encrypted-file token store. Use as a fallback when no keychain backend
 * is available, or directly for tests / CI environments without keychain
 * access.
 */
export class EncryptedFileTokenStore implements TokenStore {
    private readonly dir: string;
    private readonly path: string;
    private readonly key: Buffer;

    constructor(opts: TokenStoreOptions) {
        const home = opts.homedir ?? defaultHomedir();
        const root = opts.dataDir ?? join(home, `.${SERVICE_BASE}`);
        this.dir = join(root, opts.namespace);
        this.path = join(this.dir, FILE_NAME);
        this.key = deriveKey(opts.namespace, home);
    }

    /** Read and decrypt the cached token bundle, or null if absent. */
    async get(): Promise<TokenData | null> {
        if (!existsSync(this.path)) return null;
        try {
            const blob = readFileSync(this.path);
            const json = decrypt(blob, this.key);
            return JSON.parse(json) as TokenData;
        } catch {
            // Corrupted or wrong-key file: treat as absent rather than throwing.
            // The caller will fall back to a fresh login.
            return null;
        }
    }

    /** Encrypt the bundle and write it with mode 0600. */
    async set(tokens: TokenData): Promise<void> {
        try {
            if (!existsSync(this.dir)) {
                mkdirSync(this.dir, { mode: DIR_MODE, recursive: true });
            }
            const blob = encrypt(JSON.stringify(tokens), this.key);
            writeFileSync(this.path, blob, { mode: FILE_MODE });
        } catch (cause) {
            throw new TokenStoreError(
                'TOKEN_STORE_WRITE_FAILED',
                `failed to write encrypted token file at ${this.path}`,
                cause,
            );
        }
    }

    /** Delete the encrypted token file if it exists. */
    async clear(): Promise<void> {
        if (existsSync(this.path)) {
            unlinkSync(this.path);
        }
    }
}
