/** Property tests for deterministic recorded-expiry classification. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { tokenData } from '../testFixtures.js';
import { classifyCredential } from './manager.js';

const SAFETY_BUFFER_MS = 60_000;
const FINITE_TIME = fc.double({
    min: -1_000_000_000_000,
    max: 1_000_000_000_000,
    noNaN: true,
    noDefaultInfinity: true,
});

describe('recorded-expiry freshness boundary', () => {
    it('Feature: reuse-existing-auth-session, Property 4: Recorded expiry partitions freshness at the safety boundary', () => {
        // **Validates: Requirements 4.1, 4.2**
        fc.assert(
            fc.property(FINITE_TIME, FINITE_TIME, (now, expiresAt) => {
                const boundary = now + SAFETY_BUFFER_MS;
                const expected = expiresAt > boundary
                    ? 'credential-fresh'
                    : 'credential-stale';

                expect(classifyCredential(tokenData({ expires_at: expiresAt }), now)).toBe(
                    expected,
                );
                expect(classifyCredential(tokenData({ expires_at: boundary }), now)).toBe(
                    'credential-stale',
                );
                expect(classifyCredential(tokenData({ expires_at: boundary - 1 }), now)).toBe(
                    'credential-stale',
                );
                expect(classifyCredential(tokenData({ expires_at: boundary + 1 }), now)).toBe(
                    'credential-fresh',
                );
            }),
            { numRuns: 100 },
        );
    });
});
