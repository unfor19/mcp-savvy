/**
 * Derive a stable token-storage namespace from the issuer + client ID.
 *
 * The namespace must be:
 *   - deterministic: same inputs produce the same value, so the
 *     same protected MCP keeps the same keychain entry across
 *     restarts;
 *   - unique enough: two different protected MCPs on the same host
 *     must NOT collide;
 *   - safe for filesystem and keychain service names: stick to
 *     `[a-z0-9-]`.
 */

import { createHash } from 'node:crypto';

/** Length of the clientId hash suffix appended to the issuer host. */
const CLIENT_HASH_LEN = 8;
/** Maximum total namespace length (filesystem-safe across platforms). */
const MAX_LEN = 60;

/**
 * Build the namespace. Examples:
 *   issuer="https://cognito-idp.us-east-1.amazonaws.com/us-east-1_xxx"
 *   clientId="abcd1234"
 *   → "cognito-idp-us-east-1-amazonaws-com-us-east-1-xxx-3a7c0b9e"
 */
export function deriveNamespace(issuer: string, clientId: string): string {
    let host: string;
    try {
        const url = new URL(issuer);
        host = url.host + url.pathname;
    } catch {
        host = issuer;
    }
    const hostSlug = slugify(host) || 'unknown';
    const clientHash = createHash('sha256')
        .update(clientId)
        .digest('hex')
        .slice(0, CLIENT_HASH_LEN);
    const combined = `${hostSlug}-${clientHash}`;
    if (combined.length <= MAX_LEN) return combined;
    // Trim from the host side; the hash is the uniqueness guarantee.
    const headroom = MAX_LEN - clientHash.length - 1;
    return `${hostSlug.slice(0, headroom)}-${clientHash}`;
}

/** Lower-case + collapse non-alphanumeric runs to single dashes. */
function slugify(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
