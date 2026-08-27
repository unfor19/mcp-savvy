/**
 * Unit tests for the namespace deriver.
 */

import { describe, it, expect } from 'vitest';
import { deriveNamespace } from './namespace.js';

describe('deriveNamespace', () => {
    it('combines a slugified host with a hash of the client ID', () => {
        const ns = deriveNamespace(
            'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_xxx',
            'abcd1234',
        );
        expect(ns).toMatch(/^cognito-idp-us-east-1-amazonaws-com-us-east-1-xxx-[a-f0-9]{8}$/);
    });

    it('is deterministic across calls', () => {
        const a = deriveNamespace('https://x.example/oidc', 'cid');
        const b = deriveNamespace('https://x.example/oidc', 'cid');
        expect(a).toBe(b);
    });

    it('produces distinct namespaces for distinct client IDs', () => {
        const a = deriveNamespace('https://x.example/oidc', 'one');
        const b = deriveNamespace('https://x.example/oidc', 'two');
        expect(a).not.toBe(b);
    });

    it('produces distinct namespaces for distinct issuers', () => {
        const a = deriveNamespace('https://a.example', 'cid');
        const b = deriveNamespace('https://b.example', 'cid');
        expect(a).not.toBe(b);
    });

    it('falls back to "unknown" when the issuer has no usable host or path', () => {
        const ns = deriveNamespace('not-a-url::', 'cid');
        expect(ns).toMatch(/^unknown-[a-f0-9]{8}$/);
    });

    it('uses the literal "unknown" prefix when the issuer slugs to empty', () => {
        const ns = deriveNamespace('::', 'cid');
        expect(ns).toMatch(/^unknown-[a-f0-9]{8}$/);
    });

    it('survives genuinely-invalid URL strings via the catch path', () => {
        // Whitespace-only strings throw inside `new URL`.
        const ns = deriveNamespace('   ', 'cid');
        expect(ns).toMatch(/^unknown-[a-f0-9]{8}$/);
    });

    it('caps total length to keep the keychain service name sane', () => {
        const longIssuer = 'https://' + 'x'.repeat(200) + '.example/oidc';
        const ns = deriveNamespace(longIssuer, 'cid');
        expect(ns.length).toBeLessThanOrEqual(60);
        expect(ns).toMatch(/-[a-f0-9]{8}$/);
    });

    it('only contains lower-case alphanumerics and dashes', () => {
        const ns = deriveNamespace('https://CASE.Example.COM/Path?q=1', 'cid');
        expect(ns).toMatch(/^[a-z0-9-]+$/);
    });
});
