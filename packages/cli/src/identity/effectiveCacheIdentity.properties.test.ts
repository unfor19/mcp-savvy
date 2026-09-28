/** Property tests for equivalent effective-cache identities and configuration drift. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
    resolveEffectiveCacheIdentity,
    type EffectiveCacheIdentityInput,
} from './index.js';

const SAFE_CHARACTER = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789');
const SAFE_TEXT = fc
    .array(SAFE_CHARACTER, { minLength: 1, maxLength: 64 })
    .map((characters) => characters.join(''));
const ISSUER = fc
    .record({
        host: SAFE_TEXT,
        path: fc.array(SAFE_TEXT, { maxLength: 4 }),
    })
    .map(({ host, path }) =>
        `https://${host}.example${path.length === 0 ? '' : `/${path.join('/')}`}`,
    );
const WHITESPACE_OVERRIDE = fc
    .array(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 1, maxLength: 12 })
    .map((characters) => characters.join(''));
const NAMESPACE_OVERRIDE = fc.oneof(
    fc.constant(undefined),
    SAFE_TEXT,
    WHITESPACE_OVERRIDE,
);
const DATA_DIR = fc
    .array(SAFE_TEXT, { minLength: 1, maxLength: 4 })
    .map((segments) => `/tmp/${segments.join('/')}`);
const EFFECTIVE_CACHE_IDENTITY_INPUT = fc.record({
    issuer: ISSUER,
    clientId: SAFE_TEXT,
    namespaceOverride: NAMESPACE_OVERRIDE,
    dataDir: DATA_DIR,
    userContext: SAFE_TEXT,
}) satisfies fc.Arbitrary<EffectiveCacheIdentityInput>;

describe('effective cache identity equivalence and drift', () => {
    it('Feature: reuse-existing-auth-session, Property 2: Equivalent configurations produce equivalent cache identities', () => {
        // **Validates: Requirements 2.3, 2.6, 7.2, 7.9**
        fc.assert(
            fc.property(EFFECTIVE_CACHE_IDENTITY_INPUT, (input) => {
                const first = resolveEffectiveCacheIdentity({ ...input });
                const second = resolveEffectiveCacheIdentity({ ...input });

                expect(second.namespace).toBe(first.namespace);
                expect(second.componentFingerprints).toEqual(first.componentFingerprints);
                expect(second.fingerprint).toBe(first.fingerprint);
            }),
            { numRuns: 100 },
        );
    });

    it('Feature: reuse-existing-auth-session, Property 3: Cache identity detects configuration drift', () => {
        // **Validates: Requirements 2.4**
        fc.assert(
            fc.property(EFFECTIVE_CACHE_IDENTITY_INPUT, (input) => {
                const baseline = resolveEffectiveCacheIdentity(input);
                const issuerDrift = resolveEffectiveCacheIdentity({
                    ...input,
                    issuer: input.issuer.replace('https://', 'https://issuer-drift-'),
                });
                const clientIdDrift = resolveEffectiveCacheIdentity({
                    ...input,
                    clientId: `${input.clientId}-client-drift`,
                });
                const namespaceIsExplicit = Boolean(input.namespaceOverride?.trim());

                expect(issuerDrift.componentFingerprints.issuer).not.toBe(
                    baseline.componentFingerprints.issuer,
                );
                expect(clientIdDrift.componentFingerprints.clientId).not.toBe(
                    baseline.componentFingerprints.clientId,
                );
                if (namespaceIsExplicit) {
                    expect(issuerDrift.fingerprint).toBe(baseline.fingerprint);
                    expect(clientIdDrift.fingerprint).toBe(baseline.fingerprint);
                } else {
                    expect(issuerDrift.fingerprint).not.toBe(baseline.fingerprint);
                    expect(clientIdDrift.fingerprint).not.toBe(baseline.fingerprint);
                }

                const effectiveIdentityDrift: EffectiveCacheIdentityInput[] = [
                    { ...input, dataDir: `${input.dataDir}/data-dir-drift` },
                    {
                        ...input,
                        namespaceOverride: namespaceIsExplicit
                            ? `${input.namespaceOverride}-namespace-drift`
                            : 'namespace-drift',
                    },
                    { ...input, userContext: `${input.userContext}-user-drift` },
                ];
                for (const driftedInput of effectiveIdentityDrift) {
                    expect(resolveEffectiveCacheIdentity(driftedInput).fingerprint).not.toBe(
                        baseline.fingerprint,
                    );
                }
            }),
            { numRuns: 100 },
        );
    });
});
