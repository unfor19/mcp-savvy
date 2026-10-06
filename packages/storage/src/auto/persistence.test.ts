/**
 * Tests for `AutoTokenStore` persistence: keychain-first writes, file
 * fallback, stale-entry removal, and clearing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStoreError } from '@mcp-savvy/core';
import { AutoTokenStore } from '../auto.js';
import { KeychainReadError } from '../keychain/index.js';
import { fakeFile, fakeKeychain, sampleTokens } from './testFixtures.js';

let fakeHome: string;

beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'mcp-savvy-auto-persist-'));
});

afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
});

/** Build a logger double whose `warn` calls can be asserted. */
function spyLogger() {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return { ...logger, child: () => logger as never };
}

describe('set', () => {
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

    it('removes a stale keychain entry after falling back to the file', async () => {
        const keychain = fakeKeychain();
        keychain.store.set('value', JSON.stringify({ ...sampleTokens, access_token: 'stale' }));
        keychain.setShouldFail = true;
        const file = fakeFile(sampleTokens);
        const store = new AutoTokenStore({ namespace: 'write', keychain, file });

        await store.set(sampleTokens);
        expect(file.set).toHaveBeenCalledWith(sampleTokens);
        expect(keychain.store.has('value')).toBe(false);
    });

    it('reads the fresh file tokens, not the stale keychain entry, after a failed keychain write', async () => {
        const keychain = fakeKeychain();
        keychain.store.set('value', JSON.stringify({ ...sampleTokens, access_token: 'stale' }));
        keychain.setShouldFail = true;
        const store = new AutoTokenStore({ namespace: 'shadow', homedir: fakeHome, keychain });

        await store.set({ ...sampleTokens, access_token: 'fresh' });
        expect(await store.get()).toMatchObject({ access_token: 'fresh' });
    });

    it('keeps the keychain entry when the file fallback also fails', async () => {
        const keychain = fakeKeychain();
        const stale = JSON.stringify({ ...sampleTokens, access_token: 'stale' });
        keychain.store.set('value', stale);
        keychain.setShouldFail = true;
        const file = fakeFile(sampleTokens);
        file.set.mockRejectedValue(new Error('synthetic failure'));
        const store = new AutoTokenStore({ namespace: 'write', keychain, file });

        await expect(store.set(sampleTokens)).rejects.toMatchObject({
            code: 'TOKEN_STORE_WRITE_FAILED',
        });
        expect(keychain.store.get('value')).toBe(stale);
    });

    it('warns but still succeeds when the stale keychain entry cannot be removed', async () => {
        const keychain = fakeKeychain();
        keychain.store.set('value', JSON.stringify(sampleTokens));
        keychain.setShouldFail = true;
        keychain.delete = () => false;
        const logger = spyLogger();
        const store = new AutoTokenStore(
            { namespace: 'write', keychain, file: fakeFile(sampleTokens) },
            logger,
        );

        await expect(store.set(sampleTokens)).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('stale'));
    });

    it('does not warn when a backend reports the absent entry as a failed delete', async () => {
        const keychain = fakeKeychain();
        keychain.setShouldFail = true;
        keychain.delete = () => false;
        const logger = spyLogger();
        const store = new AutoTokenStore(
            { namespace: 'write', keychain, file: fakeFile(sampleTokens) },
            logger,
        );

        await store.set(sampleTokens);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('keychain write failed'));
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

describe('clear', () => {
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

    it('deletes without reading the keychain secret first', async () => {
        const keychain = fakeKeychain();
        keychain.store.set('value', JSON.stringify(sampleTokens));
        const get = vi.spyOn(keychain, 'get');
        const store = new AutoTokenStore({ namespace: 'clear', keychain, file: fakeFile(null) });

        await store.clear();
        expect(get).not.toHaveBeenCalled();
        expect(keychain.store.has('value')).toBe(false);
    });

    it('removes an unreadable keychain entry instead of failing on the read', async () => {
        const keychain = fakeKeychain();
        keychain.store.set('value', JSON.stringify(sampleTokens));
        keychain.get = () => {
            throw new KeychainReadError('permission-denied');
        };
        const file = fakeFile(sampleTokens);
        const store = new AutoTokenStore({ namespace: 'clear', keychain, file });

        await expect(store.clear()).resolves.toBeUndefined();
        expect(keychain.store.has('value')).toBe(false);
        expect(file.clear).toHaveBeenCalledOnce();
    });

    it('still fails when deletion fails and the entry cannot be confirmed missing', async () => {
        const keychain = fakeKeychain();
        keychain.delete = () => false;
        keychain.get = () => {
            throw new KeychainReadError('permission-denied');
        };
        const store = new AutoTokenStore({ namespace: 'clear', keychain, file: fakeFile(null) });

        await expect(store.clear()).rejects.toMatchObject({ code: 'TOKEN_STORE_CLEAR_FAILED' });
    });

    it('treats an already-missing keychain entry as a successful clear', async () => {
        const keychain = fakeKeychain();
        keychain.delete = () => false;
        const file = fakeFile(sampleTokens);
        const store = new AutoTokenStore({ namespace: 'clear', keychain, file });

        await expect(store.clear()).resolves.toBeUndefined();
        expect(file.clear).toHaveBeenCalledOnce();
    });
});
