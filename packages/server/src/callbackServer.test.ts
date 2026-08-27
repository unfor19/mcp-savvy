/**
 * Integration tests for `CallbackServer`. We boot a real listener on
 * an ephemeral port (`port: 0`) and drive it with `fetch`. Each test
 * stops its own server via the resolved/rejected promise.
 */

import { describe, it, expect } from 'vitest';
import { AuthError, McpSavvyError } from '@mcp-savvy/core';
import { CallbackServer } from './callbackServer.js';

const STATE = 'state-abc-123';
const CODE = 'auth-code-xyz';
const PATH = '/callback';

/** Boot a `CallbackServer` on an ephemeral port and return its URL. */
async function bootServer(opts?: {
    expectedPath?: string;
    brandName?: string;
    host?: 'localhost' | '127.0.0.1';
}): Promise<{ server: CallbackServer; url: URL }> {
    const server = new CallbackServer({
        port: 0,
        expectedPath: opts?.expectedPath ?? PATH,
        ...(opts?.host !== undefined ? { host: opts.host } : {}),
        ...(opts?.brandName !== undefined ? { brandName: opts.brandName } : {}),
    });
    const url = await server.listen();
    return { server, url };
}

describe('successful callback', () => {
    it('resolves with the captured code and state', async () => {
        const { server, url } = await bootServer();
        const waiting = server.awaitCallback({ state: STATE, timeoutMs: 5_000 });
        const target = new URL(url);
        target.searchParams.set('code', CODE);
        target.searchParams.set('state', STATE);
        const res = await fetch(target);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/text\/html/);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('referrer-policy')).toBe('no-referrer');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('x-frame-options')).toBe('DENY');
        const body = await res.text();
        expect(body).toContain('Signed in');
        const result = await waiting;
        expect(result).toEqual({ code: CODE, state: STATE });
    });

    it('advertises localhost by default', async () => {
        const { server, url } = await bootServer();
        try {
            // Default advertised URL uses 'localhost' (project
            // convention). The actual bind is still 127.0.0.1 — see
            // the explicit-127.0.0.1 test below.
            expect(url.hostname).toBe('localhost');
            expect(server.redirectUri).toMatch(/^http:\/\/localhost:/);
        } finally {
            await server.stop();
        }
    });

    it('honors host=127.0.0.1 when explicitly requested', async () => {
        const { server, url } = await bootServer({ host: '127.0.0.1' });
        try {
            expect(url.hostname).toBe('127.0.0.1');
            expect(server.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:/);
        } finally {
            await server.stop();
        }
    });

    it('advertises the configured host (localhost) while still binding to 127.0.0.1', async () => {
        const { server, url } = await bootServer({ host: 'localhost' });
        try {
            // Advertised URL is what the IdP saw — must match the
            // redirect URI registered on the IdP side.
            expect(url.hostname).toBe('localhost');
            expect(server.redirectUri).toMatch(/^http:\/\/localhost:/);
        } finally {
            await server.stop();
        }
    });

    it('uses the provided brand name in the success page', async () => {
        const { server, url } = await bootServer({ brandName: 'ACME-AUTH' });
        const waiting = server.awaitCallback({ state: STATE, timeoutMs: 5_000 });
        const target = new URL(url);
        target.searchParams.set('code', CODE);
        target.searchParams.set('state', STATE);
        const res = await fetch(target);
        const body = await res.text();
        expect(body).toContain('ACME-AUTH');
        await waiting;
    });
});

describe('CSRF / state mismatch', () => {
    it('keeps listening after a wrong state and accepts the correlated callback', async () => {
        const { server, url } = await bootServer();
        const waiting = server.awaitCallback({ state: STATE, timeoutMs: 5_000 });
        const target = new URL(url);
        target.searchParams.set('code', CODE);
        target.searchParams.set('state', 'wrong-state');
        const res = await fetch(target);
        expect(res.status).toBe(400);
        target.searchParams.set('state', STATE);
        expect((await fetch(target)).status).toBe(200);
        await expect(waiting).resolves.toEqual({ code: CODE, state: STATE });
    });

    it('keeps listening after a missing state and accepts the correlated callback', async () => {
        const { server, url } = await bootServer();
        const waiting = server.awaitCallback({ state: STATE, timeoutMs: 5_000 });
        const target = new URL(url);
        target.searchParams.set('code', CODE);
        expect((await fetch(target)).status).toBe(400);
        target.searchParams.set('state', STATE);
        expect((await fetch(target)).status).toBe(200);
        await expect(waiting).resolves.toEqual({ code: CODE, state: STATE });
    });
});

describe('IdP-reported errors', () => {
    it('rejects with AUTH_PROVIDER_ERROR and HTML-escapes the description', async () => {
        const { server, url } = await bootServer();
        const waiting = server.awaitCallback({ state: STATE, timeoutMs: 5_000 });
        const expectation = expect(waiting).rejects.toMatchObject({
            code: 'AUTH_PROVIDER_ERROR',
        });
        const target = new URL(url);
        target.searchParams.set('error', 'access_denied');
        target.searchParams.set('error_description', '<script>alert(1)</script>');
        target.searchParams.set('state', STATE);
        const res = await fetch(target);
        expect(res.status).toBe(400);
        const body = await res.text();
        // Description must be escaped.
        expect(body).not.toContain('<script>alert(1)</script>');
        expect(body).toContain('&lt;script&gt;');
        await expectation;
    });

    it('rejects with AUTH_PROVIDER_ERROR when code is missing but state matches', async () => {
        const { server, url } = await bootServer();
        const waiting = server.awaitCallback({ state: STATE, timeoutMs: 5_000 });
        const expectation = expect(waiting).rejects.toMatchObject({
            code: 'AUTH_PROVIDER_ERROR',
        });
        const target = new URL(url);
        target.searchParams.set('state', STATE);
        await fetch(target);
        await expectation;
    });
});

describe('routing', () => {
    it('returns 404 for unknown paths', async () => {
        const { server, url } = await bootServer();
        const waiting = server.awaitCallback({ state: STATE, timeoutMs: 1_000 });
        const expectation = expect(waiting).rejects.toMatchObject({ code: 'AUTH_TIMEOUT' });
        const target = new URL(url);
        target.pathname = '/some/random/path';
        const res = await fetch(target);
        expect(res.status).toBe(404);
        // The server stays up — the wait then times out.
        await expectation;
    });

    it('returns 404 for non-GET methods on the callback path', async () => {
        const { server, url } = await bootServer();
        const waiting = server.awaitCallback({ state: STATE, timeoutMs: 1_000 });
        const expectation = expect(waiting).rejects.toMatchObject({ code: 'AUTH_TIMEOUT' });
        const res = await fetch(url, { method: 'POST' });
        expect(res.status).toBe(404);
        await expectation;
    });

    it('honors a custom expectedPath', async () => {
        const { server, url } = await bootServer({ expectedPath: '/oauth/callback' });
        expect(url.pathname).toBe('/oauth/callback');
        const waiting = server.awaitCallback({ state: STATE, timeoutMs: 5_000 });
        const target = new URL(url);
        target.searchParams.set('code', CODE);
        target.searchParams.set('state', STATE);
        await fetch(target);
        await expect(waiting).resolves.toEqual({ code: CODE, state: STATE });
    });
});

describe('lifecycle', () => {
    it('throws if awaitCallback is called before listen()', async () => {
        const server = new CallbackServer({ port: 0 });
        await expect(
            server.awaitCallback({ state: STATE, timeoutMs: 100 }),
        ).rejects.toBeInstanceOf(McpSavvyError);
    });

    it('listen() is idempotent', async () => {
        const server = new CallbackServer({ port: 0 });
        const url1 = await server.listen();
        const url2 = await server.listen();
        expect(url1.toString()).toBe(url2.toString());
        await server.stop();
    });

    it('stop() is idempotent', async () => {
        const server = new CallbackServer({ port: 0 });
        await server.listen();
        await server.stop();
        await server.stop(); // second stop must not throw
    });

    it('times out when no callback arrives', async () => {
        const { server } = await bootServer();
        const start = Date.now();
        await expect(
            server.awaitCallback({ state: STATE, timeoutMs: 200 }),
        ).rejects.toBeInstanceOf(AuthError);
        const elapsed = Date.now() - start;
        // Generous lower bound to absorb timer drift under v8 coverage.
        expect(elapsed).toBeGreaterThanOrEqual(150);
        expect(elapsed).toBeLessThan(2_000);
    });

    it('closes the listener after a successful callback', async () => {
        const { server, url } = await bootServer();
        const waiting = server.awaitCallback({ state: STATE, timeoutMs: 5_000 });
        const target = new URL(url);
        target.searchParams.set('code', CODE);
        target.searchParams.set('state', STATE);
        await fetch(target);
        await waiting;
        // After resolution, the port is free again — confirm by failing to connect.
        await expect(fetch(target)).rejects.toThrow();
    });
});

describe('redirectUri', () => {
    it('reflects the configured port and path', () => {
        const server = new CallbackServer({ port: 12345, expectedPath: '/cb' });
        expect(server.redirectUri).toBe('http://localhost:12345/cb');
    });
});
