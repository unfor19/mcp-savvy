/**
 * Property tests for deterministic backend credential selection.
 */

import type { TokenData } from '@mcp-savvy/core';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { AutoTokenStore, type BackendReadEvent } from '../auto.js';
import {
    KeychainReadError,
    type KeychainBackend,
    type KeychainReadFailureCategory,
    type KeychainReadResult,
} from '../keychain/index.js';
import type { TokenStore } from '../types.js';

const validBundle: fc.Arbitrary<TokenData> = fc.record({
    access_token: fc.string({ minLength: 1 }),
    refresh_token: fc.string(),
    id_token: fc.string(),
    expires_at: fc.double({ noNaN: true, noDefaultInfinity: true }),
});

type SafeOutcome =
    | 'missing'
    | 'unreadable-local-entry'
    | 'undecodable-value'
    | 'invalid-value';

const safeOutcome = fc.constantFrom<SafeOutcome>(
    'missing',
    'unreadable-local-entry',
    'undecodable-value',
    'invalid-value',
);

const failureCategory = fc.constantFrom<KeychainReadFailureCategory>(
    'permission-denied',
    'integrity-failure',
    'invocation-failure',
    'operational-failure',
);

type SelectionOutcome =
    | { kind: 'valid' }
    | { kind: 'safe'; outcome: SafeOutcome }
    | { kind: 'failure'; category: KeychainReadFailureCategory };

const selectionOutcome: fc.Arbitrary<SelectionOutcome> = fc.oneof(
    fc.constant({ kind: 'valid' as const }),
    safeOutcome.map((outcome) => ({ kind: 'safe' as const, outcome })),
    failureCategory.map((category) => ({ kind: 'failure' as const, category })),
);

function keychainResult(outcome: SelectionOutcome, tokens: TokenData): KeychainReadResult {
    if (outcome.kind === 'valid') {
        return { status: 'found', value: JSON.stringify(tokens) };
    }
    if (outcome.kind === 'failure') throw new KeychainReadError(outcome.category);
    if (outcome.outcome === 'missing') return { status: 'missing' };
    if (outcome.outcome === 'unreadable-local-entry') {
        return { status: 'unreadable-local-entry' };
    }
    return {
        status: 'found',
        value:
            outcome.outcome === 'undecodable-value'
                ? '{invalid-json'
                : JSON.stringify({ access_token: '', expires_at: 0 }),
    };
}

function expectedSafeReason(outcome: SafeOutcome): string {
    if (outcome === 'missing') return 'credential-missing';
    if (outcome === 'invalid-value') return 'credential-invalid';
    return 'credential-unreadable-local-entry';
}

describe('AutoTokenStore backend credential selection property', () => {
    it('Feature: reuse-existing-auth-session, Property 5: Backend selection preserves valid credentials', async () => {
        // **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
        await fc.assert(
            fc.asyncProperty(
                validBundle,
                validBundle,
                selectionOutcome,
                async (keychainTokens, fileTokens, outcome) => {
                    const fileGet = vi.fn(async () => fileTokens);
                    const file: TokenStore = {
                        get: fileGet,
                        set: vi.fn(async () => undefined),
                        clear: vi.fn(async () => undefined),
                    };
                    const keychain: KeychainBackend = {
                        name: 'property keychain',
                        isAvailable: () => true,
                        get: () => keychainResult(outcome, keychainTokens),
                        set: () => true,
                        delete: () => true,
                    };
                    const events: BackendReadEvent[] = [];
                    const store = new AutoTokenStore({
                        namespace: 'property',
                        keychain,
                        file,
                        onBackendRead: (event) => events.push(event),
                    });

                    if (outcome.kind === 'failure') {
                        await expect(store.get()).rejects.toMatchObject({
                            category: outcome.category,
                        });
                        expect(fileGet).not.toHaveBeenCalled();
                        expect(events).toEqual([]);
                        return;
                    }

                    const expectedTokens =
                        outcome.kind === 'valid'
                            ? (JSON.parse(JSON.stringify(keychainTokens)) as TokenData)
                            : fileTokens;
                    expect(await store.get()).toEqual(expectedTokens);
                    if (outcome.kind === 'valid') {
                        expect(fileGet).not.toHaveBeenCalled();
                        expect(events).toEqual([
                            {
                                backend: 'property keychain',
                                reason: 'credential-found',
                                selected: true,
                            },
                        ]);
                        return;
                    }

                    expect(fileGet).toHaveBeenCalledOnce();
                    expect(events).toEqual([
                        {
                            backend: 'property keychain',
                            reason: expectedSafeReason(outcome.outcome),
                            selected: false,
                        },
                        {
                            backend: 'encrypted file',
                            reason: 'credential-found',
                            selected: true,
                        },
                    ]);
                },
            ),
            { numRuns: 100 },
        );
    });
});
