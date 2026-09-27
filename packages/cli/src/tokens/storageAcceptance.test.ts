/**
 * Acceptance tests for encrypted-file fallback and persistence safety.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TokenData } from '@mcp-savvy/core';
import {
    AutoTokenStore,
    EncryptedFileTokenStore,
    KeychainReadError,
    type KeychainBackend,
    type KeychainReadFailureCategory,
    type KeychainReadResult,
    type TokenStore,
} from '@mcp-savvy/storage';
import { fakeCallbackServer, scriptedAuth } from '../testFixtures.js';
import { TokenManager } from './manager.js';

const NAMESPACE = 'legacy-acceptance';
const LEGACY_TOKENS: TokenData = {
    access_token: 'synthetic-legacy-access',
    refresh_token: 'synthetic-legacy-refresh',
    id_token: 'synthetic-legacy-id',
    expires_at: 4_102_444_800_000,
};

let fakeHome: string;

beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'mcp-savvy-storage-acceptance-'));
});

afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
});

function keychain(result: KeychainReadResult): KeychainBackend {
    return {
        name: 'Synthetic Keychain',
        isAvailable: () => true,
        get: () => result,
        set: () => true,
        delete: () => true,
    };
}

function tokenManager(store: TokenStore, browserLaunch = vi.fn()): {
    manager: TokenManager;
    browserLaunch: ReturnType<typeof vi.fn>;
    auth: ReturnType<typeof scriptedAuth>;
} {
    const auth = scriptedAuth();
    const callback = fakeCallbackServer({ result: { code: 'unused', state: 'unused' } });
    return {
        manager: new TokenManager({
            auth,
            store,
            createCallbackServer: () => callback.server,
            openBrowser: browserLaunch,
        }),
        browserLaunch,
        auth,
    };
}

function trackedFile(initial: TokenData | null): TokenStore & {
    current(): TokenData | null;
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
} {
    let tokens = initial;
    return {
        get: vi.fn(async () => tokens),
        set: vi.fn(async (next: TokenData) => {
            tokens = next;
        }),
        clear: vi.fn(async () => {
            tokens = null;
        }),
        current: () => tokens,
    };
}

describe('legacy credential acceptance', () => {
    it('reuses the existing keychain payload without reading the encrypted file or launching a browser', async () => {
        const file = trackedFile({ ...LEGACY_TOKENS, access_token: 'unused-file-access' });
        const store = new AutoTokenStore({
            namespace: NAMESPACE,
            keychain: keychain({ status: 'found', value: JSON.stringify(LEGACY_TOKENS) }),
            file,
        });
        const flow = tokenManager(store);

        await expect(flow.manager.getAccessToken({ forceRefresh: false })).resolves.toBe(
            LEGACY_TOKENS.access_token,
        );
        expect(file.get).not.toHaveBeenCalled();
        expect(flow.auth.calls).toEqual([]);
        expect(flow.browserLaunch).not.toHaveBeenCalled();
    });

    it.each([
        ['locally undecodable', { status: 'unreadable-local-entry' as const }],
        ['structurally invalid', { status: 'found' as const, value: '{"access_token":""}' }],
    ])('reuses a valid legacy encrypted file after a %s keychain entry', async (_label, result) => {
        const file = new EncryptedFileTokenStore({ namespace: NAMESPACE, homedir: fakeHome });
        await file.set(LEGACY_TOKENS);
        const store = new AutoTokenStore({ namespace: NAMESPACE, keychain: keychain(result), file });
        const flow = tokenManager(store);

        await expect(flow.manager.getAccessToken({ forceRefresh: false })).resolves.toBe(
            LEGACY_TOKENS.access_token,
        );
        expect(flow.auth.calls).toEqual([]);
        expect(flow.browserLaunch).not.toHaveBeenCalled();
    });
});

describe('fail-closed keychain acceptance', () => {
    it.each<KeychainReadFailureCategory>([
        'permission-denied',
        'integrity-failure',
        'invocation-failure',
        'operational-failure',
    ])('permits no fallback, mutation, or browser launch for %s', async (category) => {
        const file = trackedFile(LEGACY_TOKENS);
        const backend = keychain({ status: 'missing' });
        backend.get = () => {
            throw new KeychainReadError(category);
        };
        backend.set = vi.fn(() => true);
        backend.delete = vi.fn(() => true);
        const store = new AutoTokenStore({ namespace: NAMESPACE, keychain: backend, file });
        const flow = tokenManager(store);

        await expect(flow.manager.getAccessToken({ forceRefresh: false })).rejects.toMatchObject({
            code: 'TOKEN_STORE_READ_FAILED',
        });
        expect(file.get).not.toHaveBeenCalled();
        expect(file.set).not.toHaveBeenCalled();
        expect(file.clear).not.toHaveBeenCalled();
        expect(backend.set).not.toHaveBeenCalled();
        expect(backend.delete).not.toHaveBeenCalled();
        expect(flow.auth.calls).toEqual([]);
        expect(flow.browserLaunch).not.toHaveBeenCalled();
    });
});

describe('replacement persistence acceptance', () => {
    it('clears the superseded file only after keychain persistence succeeds', async () => {
        const order: string[] = [];
        const backend = keychain({ status: 'missing' });
        backend.set = vi.fn(() => {
            order.push('keychain-persisted');
            return true;
        });
        const file = trackedFile(LEGACY_TOKENS);
        file.clear.mockImplementation(async () => {
            order.push('file-cleared');
        });
        const store = new AutoTokenStore({ namespace: NAMESPACE, keychain: backend, file });

        await store.set({ ...LEGACY_TOKENS, access_token: 'synthetic-replacement' });
        expect(order).toEqual(['keychain-persisted', 'file-cleared']);
        expect(file.set).not.toHaveBeenCalled();
    });

    it('retains and serves the encrypted-file replacement when keychain persistence fails', async () => {
        const backend = keychain({ status: 'missing' });
        backend.set = vi.fn(() => false);
        const file = trackedFile(LEGACY_TOKENS);
        const replacement = { ...LEGACY_TOKENS, access_token: 'synthetic-file-replacement' };
        const store = new AutoTokenStore({ namespace: NAMESPACE, keychain: backend, file });

        await store.set(replacement);
        expect(file.clear).not.toHaveBeenCalled();
        expect(file.current()).toEqual(replacement);
        await expect(store.get()).resolves.toEqual(replacement);
    });

    it('reports storage failure and preserves the prior file when every backend write fails', async () => {
        const backend = keychain({ status: 'missing' });
        backend.set = vi.fn(() => false);
        const file = trackedFile(LEGACY_TOKENS);
        file.set.mockRejectedValue(new Error('synthetic encrypted-file write failure'));
        const store = new AutoTokenStore({ namespace: NAMESPACE, keychain: backend, file });

        await expect(
            store.set({ ...LEGACY_TOKENS, access_token: 'synthetic-unpersisted' }),
        ).rejects.toMatchObject({ code: 'TOKEN_STORE_WRITE_FAILED' });
        expect(file.clear).not.toHaveBeenCalled();
        expect(file.current()).toEqual(LEGACY_TOKENS);
    });
});
