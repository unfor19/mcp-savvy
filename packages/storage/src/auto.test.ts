/**
 * Tests for `AutoTokenStore` / `resolveTokenStore`. We inject a
 * scripted keychain backend (or null) directly via constructor
 * options, so the tests don't depend on the host's real keychain.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TokenData } from '@mcp-savvy/core';
import { TokenStoreError } from '@mcp-savvy/core';
import type { KeychainBackend } from './keychain/index.js';
import { AutoTokenStore, resolveTokenStore } from './auto.js';

const sampleTokens: TokenData = {
    access_token: 'a',
    refresh_token: 'r',
    id_token: 'i',
    expires_at: Date.now() + 3_600_000,
};

let fakeHome: string;

beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'mcp-savvy-auto-'));
});

afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
});

/** Build a fake keychain backend with controllable methods. */
function fakeKeychain(): KeychainBackend & {
    store: Map<string, string>;
    setShouldFail: boolean;
} {
    const store = new Map<string, string>();
    const backend = {
        name: 'Fake Keychain',
        store,
        setShouldFail: false,
        isAvailable: () => true,
        get: () => store.get('value') ?? null,
        set(value: string) {
            if (backend.setShouldFail) return false;
            store.set('value', value);
            return true;
        },
        delete() {
            store.delete('value');
            return true;
        },
    };
    return backend;
}

describe('with keychain available', () => {
    it('reports the keychain name as the backend', () => {
        const s = new AutoTokenStore({
            namespace: 'kc',
            homedir: fakeHome,
            keychain: fakeKeychain(),
        });
        expect(s.backendName).toBe('Fake Keychain');
    });

    it('writes to the keychain and not to disk', async () => {
        const kc = fakeKeychain();
        const s = new AutoTokenStore({ namespace: 'kc', homedir: fakeHome, keychain: kc });
        await s.set(sampleTokens);
        expect(kc.store.size).toBe(1);
        const filePath = join(fakeHome, '.mcp-savvy', 'kc', 'tokens.enc');
        expect(existsSync(filePath)).toBe(false);
    });

    it('reads from the keychain', async () => {
        const kc = fakeKeychain();
        const s = new AutoTokenStore({ namespace: 'kc', homedir: fakeHome, keychain: kc });
        await s.set(sampleTokens);
        expect(await s.get()).toEqual(sampleTokens);
    });

    it('returns null when the keychain holds invalid JSON', async () => {
        const kc = fakeKeychain();
        kc.store.set('value', '{not json');
        const s = new AutoTokenStore({ namespace: 'kc', homedir: fakeHome, keychain: kc });
        expect(await s.get()).toBeNull();
    });

    it('returns null when the keychain holds a non-object JSON value', async () => {
        const kc = fakeKeychain();
        kc.store.set('value', '"just a string"');
        const s = new AutoTokenStore({ namespace: 'kc', homedir: fakeHome, keychain: kc });
        expect(await s.get()).toBeNull();
    });

    it('falls back to encrypted file when keychain set fails', async () => {
        const kc = fakeKeychain();
        kc.setShouldFail = true;
        const s = new AutoTokenStore({ namespace: 'kc', homedir: fakeHome, keychain: kc });
        await s.set(sampleTokens);
        expect(kc.store.size).toBe(0);
        const filePath = join(fakeHome, '.mcp-savvy', 'kc', 'tokens.enc');
        expect(existsSync(filePath)).toBe(true);
    });

    it('reads from the encrypted file when the keychain has no value', async () => {
        const kc = fakeKeychain();
        // Write only to the file, not the keychain.
        const fileOnly = new AutoTokenStore({
            namespace: 'kc',
            homedir: fakeHome,
            keychain: null,
        });
        await fileOnly.set(sampleTokens);
        const withKc = new AutoTokenStore({
            namespace: 'kc',
            homedir: fakeHome,
            keychain: kc,
        });
        expect(await withKc.get()).toEqual(sampleTokens);
    });

    it('clear() drops both backends', async () => {
        const kc = fakeKeychain();
        const s = new AutoTokenStore({ namespace: 'kc', homedir: fakeHome, keychain: kc });
        await s.set(sampleTokens);
        await s.clear();
        expect(kc.store.size).toBe(0);
        expect(await s.get()).toBeNull();
    });
});

describe('without keychain', () => {
    it('reports "encrypted file" as the backend', () => {
        const s = new AutoTokenStore({
            namespace: 'file-only',
            homedir: fakeHome,
            keychain: null,
        });
        expect(s.backendName).toBe('encrypted file');
    });

    it('writes and reads through the encrypted file', async () => {
        const s = new AutoTokenStore({
            namespace: 'file-only',
            homedir: fakeHome,
            keychain: null,
        });
        await s.set(sampleTokens);
        expect(await s.get()).toEqual(sampleTokens);
    });

    it('throws TokenStoreError when the file write fails', async () => {
        const s = new AutoTokenStore({
            namespace: 'file-only',
            homedir: '/dev/null/cannot-write',
            keychain: null,
        });
        await expect(s.set(sampleTokens)).rejects.toBeInstanceOf(TokenStoreError);
    });
});

describe('migration', () => {
    it('clears the encrypted file after a successful keychain write', async () => {
        // First, write to the encrypted file (simulating a prior run with no keychain).
        const fileOnly = new AutoTokenStore({
            namespace: 'migrate',
            homedir: fakeHome,
            keychain: null,
        });
        await fileOnly.set(sampleTokens);
        const filePath = join(fakeHome, '.mcp-savvy', 'migrate', 'tokens.enc');
        expect(existsSync(filePath)).toBe(true);
        // Now switch to a host with a keychain and write again.
        const kc = fakeKeychain();
        const withKc = new AutoTokenStore({
            namespace: 'migrate',
            homedir: fakeHome,
            keychain: kc,
        });
        await withKc.set(sampleTokens);
        expect(kc.store.size).toBe(1);
        expect(existsSync(filePath)).toBe(false);
    });
});

describe('resolveTokenStore', () => {
    it('returns an AutoTokenStore', () => {
        const s = resolveTokenStore({ namespace: 'r', homedir: fakeHome });
        expect(s).toBeInstanceOf(AutoTokenStore);
    });
});
