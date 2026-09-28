/**
 * Tests for deterministic `AutoTokenStore` precedence and persistence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TokenData } from '@mcp-savvy/core';
import { TokenStoreError } from '@mcp-savvy/core';
import { AutoTokenStore, resolveTokenStore, type BackendReadEvent } from './auto.js';
import { KeychainReadError, type KeychainBackend } from './keychain/index.js';
import type { TokenStore } from './types.js';

const sampleTokens: TokenData = {
    access_token: 'a',
    refresh_token: 'r',
    id_token: 'i',
    expires_at: 1_700_000_000_000,
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
        get: () => {
            const value = store.get('value');
            return value === undefined
                ? { status: 'missing' as const }
                : { status: 'found' as const, value };
        },
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

function fakeFile(tokens: TokenData | null): TokenStore & {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
} {
    return {
        get: vi.fn(async () => tokens),
        set: vi.fn(async () => undefined),
        clear: vi.fn(async () => undefined),
    };
}

describe('backend metadata', () => {
    it('reports deterministic keychain-first precedence', () => {
        const store = new AutoTokenStore({
            namespace: 'metadata',
            homedir: fakeHome,
            keychain: fakeKeychain(),
        });
        expect(store.backendName).toBe('Fake Keychain');
        expect(store.backendMetadata).toEqual({
            available: ['Fake Keychain', 'encrypted file'],
            preferred: 'Fake Keychain',
        });
    });

    it('reports only the encrypted file without a keychain', () => {
        const store = new AutoTokenStore({
            namespace: 'metadata',
            homedir: fakeHome,
            keychain: null,
        });
        expect(store.backendMetadata).toEqual({
            available: ['encrypted file'],
            preferred: 'encrypted file',
        });
    });
});

describe('read precedence', () => {
    it('selects valid keychain tokens without reading the file', async () => {
        const keychain = fakeKeychain();
        keychain.store.set('value', JSON.stringify(sampleTokens));
        const file = fakeFile({ ...sampleTokens, access_token: 'file' });
        const events: BackendReadEvent[] = [];
        const store = new AutoTokenStore({
            namespace: 'read',
            keychain,
            file,
            onBackendRead: (event) => events.push(event),
        });

        expect(await store.get()).toEqual(sampleTokens);
        expect(file.get).not.toHaveBeenCalled();
        expect(events).toEqual([
            { backend: 'Fake Keychain', reason: 'credential-found', selected: true },
        ]);
    });

    it.each([
        ['documented missing', { status: 'missing' as const }, 'credential-missing'],
        [
            'locally unreadable',
            { status: 'unreadable-local-entry' as const },
            'credential-unreadable-local-entry',
        ],
    ])('falls back after a %s keychain outcome', async (_label, result, reason) => {
        const keychain = fakeKeychain();
        keychain.get = () => result;
        const file = fakeFile(sampleTokens);
        const events: BackendReadEvent[] = [];
        const store = new AutoTokenStore({
            namespace: 'read',
            keychain,
            file,
            onBackendRead: (event) => events.push(event),
        });

        expect(await store.get()).toEqual(sampleTokens);
        expect(events).toEqual([
            { backend: 'Fake Keychain', reason, selected: false },
            { backend: 'encrypted file', reason: 'credential-found', selected: true },
        ]);
    });

    it.each([
        ['undecodable JSON', '{not-json', 'credential-unreadable-local-entry'],
        ['invalid token shape', JSON.stringify({ access_token: '', expires_at: 1 }), 'credential-invalid'],
        ['non-finite expiry', JSON.stringify({ access_token: 'a', expires_at: null }), 'credential-invalid'],
    ])('falls back when keychain data has %s', async (_label, value, reason) => {
        const keychain = fakeKeychain();
        keychain.store.set('value', value);
        const file = fakeFile(sampleTokens);
        const events: BackendReadEvent[] = [];
        const store = new AutoTokenStore({
            namespace: 'read',
            keychain,
            file,
            onBackendRead: (event) => events.push(event),
        });

        expect(await store.get()).toEqual(sampleTokens);
        expect(keychain.store.get('value')).toBe(value);
        expect(events[0]).toEqual({ backend: 'Fake Keychain', reason, selected: false });
    });

    it('fails closed on operational keychain errors without reading the file', async () => {
        const keychain = fakeKeychain();
        keychain.get = () => {
            throw new KeychainReadError('permission-denied');
        };
        const file = fakeFile(sampleTokens);
        const observer = vi.fn();
        const store = new AutoTokenStore({
            namespace: 'read',
            keychain,
            file,
            onBackendRead: observer,
        });

        await expect(store.get()).rejects.toMatchObject({ category: 'permission-denied' });
        expect(file.get).not.toHaveBeenCalled();
        expect(observer).not.toHaveBeenCalled();
    });

    it('rejects structurally invalid file data', async () => {
        const file = fakeFile({ access_token: '', expires_at: 1 } as TokenData);
        const observer = vi.fn();
        const store = new AutoTokenStore({
            namespace: 'read',
            keychain: null,
            file,
            onBackendRead: observer,
        });

        expect(await store.get()).toBeNull();
        expect(observer).toHaveBeenCalledWith({
            backend: 'encrypted file',
            reason: 'credential-invalid',
            selected: false,
        });
    });
});

describe('persistence', () => {
    it('writes to keychain then clears a superseded file', async () => {
        const keychain = fakeKeychain();
        const file = fakeFile(sampleTokens);
        const store = new AutoTokenStore({ namespace: 'write', keychain, file });

        await store.set(sampleTokens);
        expect(keychain.store.get('value')).toBe(JSON.stringify(sampleTokens));
        expect(file.clear).toHaveBeenCalledOnce();
        expect(file.set).not.toHaveBeenCalled();
    });

    it('uses and preserves the file when keychain persistence fails', async () => {
        const keychain = fakeKeychain();
        keychain.setShouldFail = true;
        const file = fakeFile(sampleTokens);
        const store = new AutoTokenStore({ namespace: 'write', keychain, file });

        await store.set(sampleTokens);
        expect(file.set).toHaveBeenCalledWith(sampleTokens);
        expect(file.clear).not.toHaveBeenCalled();
    });

    it('wraps all-backend persistence failure', async () => {
        const keychain = fakeKeychain();
        keychain.setShouldFail = true;
        const file = fakeFile(sampleTokens);
        file.set.mockRejectedValue(new Error('synthetic failure'));
        const store = new AutoTokenStore({ namespace: 'write', keychain, file });

        await expect(store.set(sampleTokens)).rejects.toMatchObject({
            code: 'TOKEN_STORE_WRITE_FAILED',
        });
    });

    it('fails when a populated keychain entry cannot be deleted but still clears the file', async () => {
        const keychain = fakeKeychain();
        keychain.store.set('value', JSON.stringify(sampleTokens));
        keychain.delete = () => false;
        const file = fakeFile(sampleTokens);
        const store = new AutoTokenStore({ namespace: 'clear', keychain, file });

        await expect(store.clear()).rejects.toMatchObject({
            code: 'TOKEN_STORE_CLEAR_FAILED',
        });
        expect(file.clear).toHaveBeenCalledOnce();
        expect(keychain.store.has('value')).toBe(true);
    });

    it('treats an already-missing keychain entry as a successful clear', async () => {
        const keychain = fakeKeychain();
        keychain.delete = () => false;
        const file = fakeFile(sampleTokens);
        const store = new AutoTokenStore({ namespace: 'clear', keychain, file });

        await expect(store.clear()).resolves.toBeUndefined();
        expect(file.clear).toHaveBeenCalledOnce();
    });

    it('retains encrypted-file compatibility when no keychain is available', async () => {
        const store = new AutoTokenStore({
            namespace: 'file-only',
            homedir: fakeHome,
            keychain: null,
        });
        await store.set(sampleTokens);
        expect(await store.get()).toEqual(sampleTokens);
        expect(existsSync(join(fakeHome, '.mcp-savvy', 'file-only', 'tokens.enc'))).toBe(true);
    });

    it('surfaces file-only write failures as TokenStoreError', async () => {
        const store = new AutoTokenStore({
            namespace: 'file-only',
            homedir: '/dev/null/cannot-write',
            keychain: null,
        });
        await expect(store.set(sampleTokens)).rejects.toBeInstanceOf(TokenStoreError);
    });
});

describe('resolveTokenStore', () => {
    it('returns an AutoTokenStore', () => {
        expect(resolveTokenStore({ namespace: 'resolved', homedir: fakeHome })).toBeInstanceOf(
            AutoTokenStore,
        );
    });
});
