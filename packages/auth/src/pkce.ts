/**
 * PKCE (RFC 7636) helpers. We use the S256 method exclusively —
 * `plain` is allowed by the spec but is strictly weaker.
 */

import { createHash, randomBytes } from 'node:crypto';

/** Code verifier length in random bytes; 64 bytes → 86 base64url chars. */
const VERIFIER_BYTES = 64;
/** State length in random bytes; 16 bytes → 22 base64url chars. */
const STATE_BYTES = 16;

/** Bundle returned by `generatePkce`. */
export interface PkceBundle {
    /** Random code verifier kept locally and sent at token exchange. */
    codeVerifier: string;
    /** SHA-256 hash of the verifier, sent in the authorize URL. */
    codeChallenge: string;
    /** PKCE method literal; always 'S256' here. */
    codeChallengeMethod: 'S256';
}

/** Convert a Buffer to a URL-safe base64 string with no padding. */
export function base64Url(input: Buffer): string {
    return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generate a fresh PKCE bundle (verifier + S256 challenge). */
export function generatePkce(): PkceBundle {
    const verifier = base64Url(randomBytes(VERIFIER_BYTES));
    const challenge = base64Url(createHash('sha256').update(verifier).digest());
    return {
        codeVerifier: verifier,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
    };
}

/** Generate a fresh CSRF-protection `state` value. */
export function generateState(): string {
    return base64Url(randomBytes(STATE_BYTES));
}
