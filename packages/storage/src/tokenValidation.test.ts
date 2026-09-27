/**
 * Unit tests for runtime validation of persisted token bundles.
 */

import { describe, expect, it } from 'vitest';
import { isTokenData } from './tokenValidation.js';

describe('isTokenData', () => {
    it('accepts the existing token representation', () => {
        expect(
            isTokenData({
                access_token: 'access',
                refresh_token: 'refresh',
                id_token: 'identity',
                expires_at: 1_700_000_000_000,
            }),
        ).toBe(true);
    });

    it('accepts a bundle without optional token fields', () => {
        expect(isTokenData({ access_token: 'access', expires_at: 0 })).toBe(true);
    });

    it.each([
        null,
        [],
        {},
        { access_token: '', expires_at: 1 },
        { access_token: 'access', expires_at: Number.NaN },
        { access_token: 'access', expires_at: Number.POSITIVE_INFINITY },
        { access_token: 'access', expires_at: '1' },
        { access_token: 'access', expires_at: 1, refresh_token: null },
        { access_token: 'access', expires_at: 1, id_token: 42 },
    ])('rejects structurally invalid input %#', (value) => {
        expect(isTokenData(value)).toBe(false);
    });
});
