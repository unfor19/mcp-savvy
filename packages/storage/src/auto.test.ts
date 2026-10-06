/**
 * Tests for deterministic `AutoTokenStore` backend metadata and read precedence.
 * Persistence tests live in `auto/persistence.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TokenData } from '@mcp-savvy/core';
import { AutoTokenStore, resolveTokenStore, type BackendReadEvent } from './auto.js';
import { fakeFile, fakeKeychain, sampleTokens } from './auto/testFixtures.js';
import { KeychainReadError } from './keychain/index.js';

let fakeHome: string;

beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'mcp-savvy-auto-'));
});

afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
});

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

describe('resolveTokenStore', () => {
    it('returns an AutoTokenStore', () => {
        expect(resolveTokenStore({ namespace: 'resolved', homedir: fakeHome })).toBeInstanceOf(
            AutoTokenStore,
        );
    });
});
