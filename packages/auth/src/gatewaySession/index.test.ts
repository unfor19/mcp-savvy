/**
 * Unit tests for `completeGatewaySession`.
 *
 * Drives the real loopback listener with real `node:http` requests
 * because the listener has no injectable seam — the security model
 * (loopback bind, hardening headers, timeout) is the contract worth
 * exercising end-to-end. Network calls to the complete-session
 * endpoint go through the injected `Fetcher`.
 *
 * Each test picks an ephemeral port (`callbackPort: 0`) so suites
 * can run in parallel without colliding on the canonical 33424.
 */

import { describe, expect, it, vi } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { AuthError } from '@mcp-savvy/core';
import { completeGatewaySession } from './index.js';
import { scriptedFetcher } from '../testFixtures.js';

const FAKE_COMPLETE_URL = 'https://api.example.com/v1/complete-session';
const FAKE_USER_TOKEN = 'header.payload.signature';
const FAKE_SESSION_URI =
    'urn:ietf:params:oauth:request_uri:01HMRC123456789ABCDEFGHJKM';
const FAKE_AUTH_URL = `https://idp.example.com/authorize?client_id=abc&state=state-sensitive&code_challenge=challenge-sensitive&request_uri=${encodeURIComponent(FAKE_SESSION_URI)}`;

interface BoundLoopback {
    readonly url: string;
    /** Resolves once the loopback server reports it's listening. */
    readonly ready: Promise<void>;
    /** Send the simulated AgentCore Identity redirect. */
    readonly hit: () => Promise<{ status: number; body: string }>;
}

/**
 * Open the browser fake by capturing the URL and (after a tick)
 * driving a real HTTP GET to the loopback port the function picked.
 * Returns a promise the caller can await to know the redirect
 * landed.
 */
function makeBrowser(opts: {
    port: number;
    path: string;
    sessionId: string;
}): { openBrowser: (url: string) => Promise<void>; opened: Promise<string>; redirectStatus: Promise<number> } {
    let resolveOpened: (url: string) => void;
    let resolveStatus: (status: number) => void;
    const opened = new Promise<string>((r) => {
        resolveOpened = r;
    });
    const redirectStatus = new Promise<number>((r) => {
        resolveStatus = r;
    });
    const openBrowser = async (url: string): Promise<void> => {
        resolveOpened(url);
        // Yield so the listener's `request` handler is fully set up.
        await sleep(15);
        const target = new URL(`http://127.0.0.1:${opts.port}${opts.path}`);
        target.searchParams.set('session_id', opts.sessionId);
        const res = await fetch(target.toString(), { method: 'GET' });
        resolveStatus(res.status);
    };
    return { openBrowser, opened, redirectStatus };
}

/** Pick a free ephemeral port for the test. */
async function freePort(): Promise<number> {
    const { createServer } = await import('node:net');
    return new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (typeof addr !== 'object' || addr === null) {
                reject(new Error('no address'));
                return;
            }
            const port = addr.port;
            server.close(() => resolve(port));
        });
    });
}

describe('completeGatewaySession', () => {
    it('completes the second-leg flow end-to-end (loopback → POST → 200)', async () => {
        const port = await freePort();
        const browser = makeBrowser({
            port,
            path: '/oauth2/callback',
            sessionId: FAKE_SESSION_URI,
        });
        const { fetcher, captured } = scriptedFetcher([
            { matchUrl: FAKE_COMPLETE_URL, response: { status: 200, headers: {}, body: '{"ok":true}' } },
        ]);
        const logger = {
            debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(),
        };

        const result = await completeGatewaySession({
            authorizationUrl: FAKE_AUTH_URL,
            completeSessionEndpoint: FAKE_COMPLETE_URL,
            userToken: FAKE_USER_TOKEN,
            openBrowser: browser.openBrowser,
            callbackPort: port,
            fetcher,
            logger,
        });

        expect(result.sessionUri).toBe(FAKE_SESSION_URI);

        // Opened the right URL.
        await expect(browser.opened).resolves.toBe(FAKE_AUTH_URL);
        const logs = JSON.stringify([
            ...logger.debug.mock.calls,
            ...logger.info.mock.calls,
            ...logger.warn.mock.calls,
            ...logger.error.mock.calls,
        ]);
        expect(logs).not.toContain(FAKE_AUTH_URL);
        expect(logs).not.toContain('state-sensitive');
        expect(logs).not.toContain('challenge-sensitive');
        expect(logs).not.toContain(FAKE_SESSION_URI);
        expect(logs).not.toContain(FAKE_SESSION_URI.slice(0, 32));

        // POSTed the right shape with Bearer auth.
        expect(captured).toHaveLength(1);
        const req = captured[0];
        expect(req).toBeDefined();
        expect(req!.method).toBe('POST');
        expect(req!.url).toBe(FAKE_COMPLETE_URL);
        expect(req!.headers?.['authorization']).toBe(`Bearer ${FAKE_USER_TOKEN}`);
        expect(req!.headers?.['content-type']).toBe('application/json');
        const parsed = JSON.parse(req!.body ?? '{}');
        expect(parsed.sessionUri).toBe(FAKE_SESSION_URI);
        expect(parsed.userToken).toBeUndefined();

        // Loopback responded 200 to the simulated AgentCore redirect.
        await expect(browser.redirectStatus).resolves.toBe(200);
    });

    it('ignores provider-error callbacks until the flow times out', async () => {
        const port = await freePort();
        let resolveOpened: (url: string) => void;
        const opened = new Promise<string>((r) => {
            resolveOpened = r;
        });
        const openBrowser = async (url: string): Promise<void> => {
            resolveOpened(url);
            await sleep(15);
            const target = new URL(`http://127.0.0.1:${port}/oauth2/callback`);
            target.searchParams.set('error', 'access_denied');
            target.searchParams.set('error_description', 'user declined consent');
            await fetch(target.toString(), { method: 'GET' });
        };
        // The fetcher must NOT be called when the IdP errors out.
        const { fetcher, captured } = scriptedFetcher([]);

        await expect(
            completeGatewaySession({
                authorizationUrl: FAKE_AUTH_URL,
                completeSessionEndpoint: FAKE_COMPLETE_URL,
                userToken: FAKE_USER_TOKEN,
                openBrowser,
                callbackPort: port,
                fetcher,
                timeoutMs: 50,
            }),
        ).rejects.toMatchObject({ code: 'AUTH_TIMEOUT' });
        await expect(opened).resolves.toBe(FAKE_AUTH_URL);
        expect(captured).toHaveLength(0);
    });

    it('ignores a callback missing session_id until timeout', async () => {
        const port = await freePort();
        const openBrowser = async (): Promise<void> => {
            await sleep(15);
            await fetch(`http://127.0.0.1:${port}/oauth2/callback`, { method: 'GET' });
        };
        const { fetcher } = scriptedFetcher([]);

        await expect(
            completeGatewaySession({
                authorizationUrl: FAKE_AUTH_URL,
                completeSessionEndpoint: FAKE_COMPLETE_URL,
                userToken: FAKE_USER_TOKEN,
                openBrowser,
                callbackPort: port,
                fetcher,
                timeoutMs: 50,
            }),
        ).rejects.toMatchObject({ code: 'AUTH_TIMEOUT' });
    });

    it('returns 404 for non-callback paths and stays open until the right one arrives', async () => {
        const port = await freePort();
        const openBrowser = async (): Promise<void> => {
            await sleep(15);
            // Hit a stray path first — should return 404 but not resolve.
            const stray = await fetch(`http://127.0.0.1:${port}/whatever`, { method: 'GET' });
            expect(stray.status).toBe(404);
            // Then the real one.
            const target = new URL(`http://127.0.0.1:${port}/oauth2/callback`);
            target.searchParams.set('session_id', FAKE_SESSION_URI);
            await fetch(target.toString(), { method: 'GET' });
        };
        const { fetcher } = scriptedFetcher([
            { matchUrl: FAKE_COMPLETE_URL, response: { status: 200, headers: {}, body: '{"ok":true}' } },
        ]);

        const result = await completeGatewaySession({
            authorizationUrl: FAKE_AUTH_URL,
            completeSessionEndpoint: FAKE_COMPLETE_URL,
            userToken: FAKE_USER_TOKEN,
            openBrowser,
            callbackPort: port,
            fetcher,
        });
        expect(result.sessionUri).toBe(FAKE_SESSION_URI);
    });

    it('rejects with AUTH_TIMEOUT if no callback arrives before timeoutMs', async () => {
        const port = await freePort();
        // Browser fake never sends a callback — promise stays pending.
        const openBrowser = async (): Promise<void> => undefined;
        const { fetcher } = scriptedFetcher([]);

        await expect(
            completeGatewaySession({
                authorizationUrl: FAKE_AUTH_URL,
                completeSessionEndpoint: FAKE_COMPLETE_URL,
                userToken: FAKE_USER_TOKEN,
                openBrowser,
                callbackPort: port,
                fetcher,
                timeoutMs: 50,
            }),
        ).rejects.toBeInstanceOf(AuthError);
    });

    it('rejects a foreign session without consuming the legitimate callback', async () => {
        const port = await freePort();
        const openBrowser = async (): Promise<void> => {
            await sleep(15);
            const foreign = new URL(`http://127.0.0.1:${port}/oauth2/callback`);
            foreign.searchParams.set('session_id', 'foreign-session');
            expect((await fetch(foreign)).status).toBe(400);
            const legitimate = new URL(`http://127.0.0.1:${port}/oauth2/callback`);
            legitimate.searchParams.set('session_id', FAKE_SESSION_URI);
            expect((await fetch(legitimate)).status).toBe(200);
        };
        const { fetcher, captured } = scriptedFetcher([
            { matchUrl: FAKE_COMPLETE_URL, response: { status: 200, headers: {}, body: '{"ok":true}' } },
        ]);

        await expect(completeGatewaySession({
            authorizationUrl: FAKE_AUTH_URL,
            completeSessionEndpoint: FAKE_COMPLETE_URL,
            userToken: FAKE_USER_TOKEN,
            openBrowser,
            callbackPort: port,
            fetcher,
        })).resolves.toEqual({ sessionUri: FAKE_SESSION_URI });
        expect(captured).toHaveLength(1);
    });

    it('fails closed before opening a URL without AgentCore request correlation', async () => {
        const openBrowser = async (): Promise<void> => {
            throw new Error('must not open');
        };
        const { fetcher, captured } = scriptedFetcher([]);
        await expect(completeGatewaySession({
            authorizationUrl: 'https://idp.example.com/authorize',
            completeSessionEndpoint: FAKE_COMPLETE_URL,
            userToken: FAKE_USER_TOKEN,
            openBrowser,
            fetcher,
        })).rejects.toMatchObject({ code: 'AUTH_PROVIDER_ERROR' });
        expect(captured).toHaveLength(0);
    });
});
