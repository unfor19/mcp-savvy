/**
 * Unit tests for the AES-256-CBC encrypted file token store.
 *
 * Each test runs in a temp directory passed via the `homedir`
 * option, so the real user's `~/.mcp-savvy` is never touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TokenData } from '@mcp-savvy/core';
import { TokenStoreError } from '@mcp-savvy/core';
import { EncryptedFileTokenStore } from './encryptedFile.js';

let fakeHome: string;

const sampleTokens: TokenData = {
    access_token: 'access-abc',
    refresh_token: 'refresh-xyz',
    id_token: 'id-123',
    expires_at: Date.now() + 3_600_000,
};

beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'mcp-savvy-test-'));
});

afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
});

describe('round trip', () => {
    it('writes then reads the same payload', async () => {
        const store = new EncryptedFileTokenStore({ namespace: 'demo', homedir: fakeHome });
        await store.set(sampleTokens);
        const loaded = await store.get();
        expect(loaded).toEqual(sampleTokens);
    });

    it('persists at <home>/.mcp-savvy/<namespace>/tokens.enc', async () => {
        const store = new EncryptedFileTokenStore({ namespace: 'demo', homedir: fakeHome });
        await store.set(sampleTokens);
        const expected = join(fakeHome, '.mcp-savvy', 'demo', 'tokens.enc');
        expect(existsSync(expected)).toBe(true);
        // File should not contain the access token in cleartext.
        const onDisk = readFileSync(expected);
        expect(onDisk.includes(Buffer.from('access-abc'))).toBe(false);
    });

    it('uses an explicit data directory without falling back to the default root', async () => {
        const dataDir = join(fakeHome, 'custom-data');
        const store = new EncryptedFileTokenStore({
            namespace: 'demo',
            homedir: fakeHome,
            dataDir,
        });
        await store.set(sampleTokens);
        expect(existsSync(join(dataDir, 'demo', 'tokens.enc'))).toBe(true);
        expect(existsSync(join(fakeHome, '.mcp-savvy', 'demo', 'tokens.enc'))).toBe(false);
        expect(await store.get()).toEqual(sampleTokens);
    });
});

describe('absent', () => {
    it('returns null when the file does not exist', async () => {
        const store = new EncryptedFileTokenStore({
            namespace: 'never-written',
            homedir: fakeHome,
        });
        expect(await store.get()).toBeNull();
    });
});

describe('corrupted', () => {
    it('returns null on garbage content (caller will re-login)', async () => {
        const store = new EncryptedFileTokenStore({ namespace: 'corrupt', homedir: fakeHome });
        await store.set(sampleTokens);
        const path = join(fakeHome, '.mcp-savvy', 'corrupt', 'tokens.enc');
        writeFileSync(path, Buffer.from('not encrypted at all'));
        expect(await store.get()).toBeNull();
    });

    it('returns null on a too-short blob', async () => {
        const store = new EncryptedFileTokenStore({ namespace: 'tiny', homedir: fakeHome });
        await store.set(sampleTokens);
        const path = join(fakeHome, '.mcp-savvy', 'tiny', 'tokens.enc');
        writeFileSync(path, Buffer.from('tiny'));
        expect(await store.get()).toBeNull();
    });
});

describe('namespace isolation', () => {
    it('different namespaces use different keys and files', async () => {
        const a = new EncryptedFileTokenStore({ namespace: 'one', homedir: fakeHome });
        const b = new EncryptedFileTokenStore({ namespace: 'two', homedir: fakeHome });
        await a.set(sampleTokens);
        expect(await b.get()).toBeNull();
    });
});

describe('clear', () => {
    it('removes the file when it exists', async () => {
        const store = new EncryptedFileTokenStore({ namespace: 'rm-me', homedir: fakeHome });
        await store.set(sampleTokens);
        await store.clear();
        expect(await store.get()).toBeNull();
    });

    it('is a no-op when the file does not exist', async () => {
        const store = new EncryptedFileTokenStore({ namespace: 'never', homedir: fakeHome });
        await expect(store.clear()).resolves.toBeUndefined();
    });

    it('overwrites cleanly on a second set() to the same store', async () => {
        // Exercises the "directory already exists" branch of mkdirSync.
        const store = new EncryptedFileTokenStore({ namespace: 'twice', homedir: fakeHome });
        await store.set(sampleTokens);
        const second = { ...sampleTokens, access_token: 'new' };
        await store.set(second);
        expect(await store.get()).toEqual(second);
    });
});

describe('defaults', () => {
    it('uses os.homedir() when no override is given', () => {
        // We don't write tokens here, just verify construction succeeds
        // with the real homedir default. This covers the `?? defaultHomedir()`
        // branch without polluting the user's home.
        const store = new EncryptedFileTokenStore({ namespace: '__test_construct_only__' });
        expect(store).toBeInstanceOf(EncryptedFileTokenStore);
    });
});

describe('write failures', () => {
    it('throws TokenStoreError when the directory cannot be created', async () => {
        const store = new EncryptedFileTokenStore({
            namespace: 'nope',
            homedir: '/dev/null/cannot-write-here',
        });
        await expect(store.set(sampleTokens)).rejects.toBeInstanceOf(TokenStoreError);
    });
});
