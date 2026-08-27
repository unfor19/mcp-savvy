/** Unit tests for credential-bearing endpoint URL policy. */

import { describe, expect, it } from 'vitest';
import { isHttpsEndpointUrl, isSecureEndpointUrl } from './url.js';

describe('isSecureEndpointUrl', () => {
    it('accepts HTTPS and exact loopback HTTP', () => {
        expect(isSecureEndpointUrl('https://api.example.com/mcp')).toBe(true);
        expect(isSecureEndpointUrl('http://localhost:33423/mcp')).toBe(true);
        expect(isSecureEndpointUrl('http://127.0.0.1:33423/mcp')).toBe(true);
        expect(isSecureEndpointUrl('http://[::1]:33423/mcp')).toBe(true);
    });

    it('rejects plaintext remote hosts, malformed URLs, and embedded credentials', () => {
        expect(isSecureEndpointUrl('http://api.example.com/mcp')).toBe(false);
        expect(isSecureEndpointUrl('http://127.0.0.1.example.com/mcp')).toBe(false);
        expect(isSecureEndpointUrl('not-a-url')).toBe(false);
        expect(isSecureEndpointUrl('https://user:secret@example.com/mcp')).toBe(false);
    });

    it('distinguishes HTTPS from the loopback HTTP development exception', () => {
        expect(isHttpsEndpointUrl('https://api.example.com/mcp')).toBe(true);
        expect(isHttpsEndpointUrl('http://localhost:33423/mcp')).toBe(false);
    });
});
