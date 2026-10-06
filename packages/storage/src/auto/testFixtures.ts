/**
 * Test-only fixtures for `AutoTokenStore` suites. Excluded from build and
 * coverage.
 */

import { vi } from 'vitest';
import type { TokenData } from '@mcp-savvy/core';
import type { KeychainBackend } from '../keychain/index.js';
import type { TokenStore } from '../types.js';

/** Valid token bundle shared by the suites. */
export const sampleTokens: TokenData = {
    access_token: 'a',
    refresh_token: 'r',
    id_token: 'i',
    expires_at: 1_700_000_000_000,
};

/** Build a fake keychain backend with controllable methods. */
export function fakeKeychain(): KeychainBackend & {
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

/** Build a spy-backed file store that returns `tokens` from `get`. */
export function fakeFile(tokens: TokenData | null): TokenStore & {
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
