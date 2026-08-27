/**
 * Unit tests for PKCE helpers.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { base64Url, generatePkce, generateState } from './pkce.js';

describe('base64Url', () => {
    it('strips padding and replaces +/ with -_', () => {
        const buf = Buffer.from([0xff, 0xfe, 0xfd]);
        expect(base64Url(buf)).toBe('__79');
    });

    it('returns an empty string for an empty buffer', () => {
        expect(base64Url(Buffer.alloc(0))).toBe('');
    });
});

describe('generatePkce', () => {
    it('returns a verifier and a matching SHA-256 challenge', () => {
        const { codeVerifier, codeChallenge, codeChallengeMethod } = generatePkce();
        expect(codeChallengeMethod).toBe('S256');
        const expected = base64Url(createHash('sha256').update(codeVerifier).digest());
        expect(codeChallenge).toBe(expected);
    });

    it('produces unique values each call', () => {
        const a = generatePkce();
        const b = generatePkce();
        expect(a.codeVerifier).not.toBe(b.codeVerifier);
        expect(a.codeChallenge).not.toBe(b.codeChallenge);
    });

    it('produces a verifier that fits RFC 7636 URL-safe constraints', () => {
        const { codeVerifier } = generatePkce();
        // Only [A-Z, a-z, 0-9, -, ., _, ~] permitted by RFC 7636.
        expect(codeVerifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
        expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
        expect(codeVerifier.length).toBeLessThanOrEqual(128);
    });
});

describe('generateState', () => {
    it('is URL-safe and unique', () => {
        const a = generateState();
        const b = generateState();
        expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(a).not.toBe(b);
    });
});
