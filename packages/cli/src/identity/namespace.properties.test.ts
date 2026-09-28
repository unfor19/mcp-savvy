/** Property tests for compatible credential namespace selection. */

import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { resolveEffectiveCacheIdentity } from './index.js';

const SAFE_CHARACTER = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789');
const SAFE_SEGMENT = fc
    .array(SAFE_CHARACTER, { minLength: 1, maxLength: 24 })
    .map((characters) => characters.join(''));
const ISSUER = fc
    .record({
        subdomain: SAFE_SEGMENT,
        domain: SAFE_SEGMENT,
        pathSegments: fc.array(SAFE_SEGMENT, { maxLength: 4 }),
    })
    .map(({ subdomain, domain, pathSegments }) => {
        const path = pathSegments.length === 0 ? '' : `/${pathSegments.join('/')}`;
        return `https://${subdomain}.${domain}.example${path}`;
    });
const CLIENT_ID = fc
    .array(SAFE_CHARACTER, { minLength: 1, maxLength: 64 })
    .map((characters) => characters.join(''));
const NONBLANK_OVERRIDE = fc
    .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'), {
        minLength: 1,
        maxLength: 60,
    })
    .map((characters) => characters.join(''));
const WHITESPACE_OVERRIDE = fc
    .array(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 1, maxLength: 12 })
    .map((characters) => characters.join(''));
const OVERRIDE = fc.oneof(
    fc.constant(undefined),
    NONBLANK_OVERRIDE,
    WHITESPACE_OVERRIDE,
);

function expectedDerivedNamespace(issuer: string, clientId: string): string {
    const url = new URL(issuer);
    const slug = `${url.host}${url.pathname}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'unknown';
    const clientHash = createHash('sha256').update(clientId).digest('hex').slice(0, 8);
    const headroom = 60 - clientHash.length - 1;
    return `${slug.slice(0, headroom)}-${clientHash}`;
}

describe('effective cache identity namespace selection', () => {
    it('Feature: reuse-existing-auth-session, Property 1: Namespace selection is deterministic and compatible', () => {
        // Validates: Requirements 2.1, 2.2, 2.5
        fc.assert(
            fc.property(ISSUER, CLIENT_ID, OVERRIDE, (issuer, clientId, namespaceOverride) => {
                const input = {
                    issuer,
                    clientId,
                    namespaceOverride,
                    dataDir: '/tmp/mcp-savvy-property-test',
                    userContext: 'property-test-user',
                };
                const expectedNamespace = namespaceOverride?.trim()
                    ? namespaceOverride
                    : expectedDerivedNamespace(issuer, clientId);

                expect(resolveEffectiveCacheIdentity(input).namespace).toBe(expectedNamespace);
                expect(resolveEffectiveCacheIdentity(input).namespace).toBe(
                    resolveEffectiveCacheIdentity(input).namespace,
                );
            }),
            { numRuns: 100 },
        );
    });
});
