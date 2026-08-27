/**
 * Local OAuth callback server.
 *
 * Boots an HTTP listener on `127.0.0.1:<port>` (loopback only — never
 * `0.0.0.0`), waits for the IdP to redirect to the configured
 * `expectedPath`, validates the `state` parameter against an expected
 * value (constant-time compare), and resolves with the captured `code`.
 *
 * The server self-closes after the first valid callback or on timeout,
 * so it can't accept arbitrary follow-up requests.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import type { Logger } from '@mcp-savvy/core';
import { AuthError, McpSavvyError } from '@mcp-savvy/core';
import { renderCallbackPage, type CallbackPageInput } from './templates.js';

/** Stable default loopback port. */
export const DEFAULT_CALLBACK_PORT = 33423;
/** Default callback path that mirrors the most common Cognito setup. */
export const DEFAULT_CALLBACK_PATH = '/callback';
/** Default wait time before we give up. 5 minutes covers slow MFA flows. */
const DEFAULT_TIMEOUT_MS = 300_000;

/** Result of `awaitCallback`. */
export interface CallbackResult {
    /** Authorization code from the IdP. */
    code: string;
    /** State value the IdP echoed back (already validated). */
    state: string;
}

/** Options for `CallbackServer`. */
export interface CallbackServerOptions {
    /** Loopback port to bind to. Defaults to 33423. */
    port?: number;
    /**
     * Loopback host to advertise in the `redirectUri`. Must be a
     * loopback name (`localhost` or `127.0.0.1`). The server always
     * binds to `127.0.0.1`; this only changes the URL we expose to
     * the IdP. Defaults to `localhost` (the project's convention);
     * pass `127.0.0.1` if that's the form your IdP's registered
     * redirect URI uses.
     */
    host?: 'localhost' | '127.0.0.1';
    /** Path the IdP redirects to. Defaults to `/callback`. */
    expectedPath?: string;
    /** Brand label shown on the rendered HTML pages. */
    brandName?: string;
    /** Optional logger. */
    logger?: Logger;
}

/** Options for `awaitCallback`. */
export interface AwaitCallbackOptions {
    /** Expected state value. The server enforces a constant-time match. */
    state: string;
    /** Wait timeout in milliseconds. Defaults to 5 minutes. */
    timeoutMs?: number;
}

/**
 * Local one-shot OAuth callback server. Always binds to loopback
 * (`127.0.0.1`) — never `0.0.0.0` — so other apps on the box can't
 * intercept the auth code.
 */
export class CallbackServer {
    private readonly requestedPort: number;
    private readonly advertisedHost: 'localhost' | '127.0.0.1';
    private readonly expectedPath: string;
    private readonly brandName: string | undefined;
    private readonly logger: Logger | undefined;
    private server: Server | null = null;
    private boundPort: number | null = null;

    constructor(opts: CallbackServerOptions = {}) {
        this.requestedPort = opts.port ?? DEFAULT_CALLBACK_PORT;
        this.advertisedHost = opts.host ?? 'localhost';
        this.expectedPath = opts.expectedPath ?? DEFAULT_CALLBACK_PATH;
        this.brandName = opts.brandName;
        this.logger = opts.logger;
    }

    /** The URL the IdP should redirect to. Reflects the actual bound port after listen(). */
    get redirectUri(): string {
        const port = this.boundPort ?? this.requestedPort;
        return `http://${this.advertisedHost}:${port}${this.expectedPath}`;
    }

    /** Bind the listener. Idempotent. */
    async listen(): Promise<URL> {
        if (this.server) return new URL(this.redirectUri);
        const server = createServer();
        this.server = server;
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            // Loopback bind — security-critical. Never 0.0.0.0.
            server.listen(this.requestedPort, '127.0.0.1', () => resolve());
        });
        const addr = server.address() as AddressInfo;
        this.boundPort = addr.port;
        this.logger?.debug(`callback server listening on 127.0.0.1:${addr.port}`);
        return new URL(this.redirectUri);
    }

    /**
     * Wait for the IdP redirect. Resolves with `{code, state}` once a
     * valid callback arrives; rejects on timeout or a correlated
     * IdP-reported error. Uncorrelated requests remain nonterminal.
     *
     * The server is closed after this promise settles either way.
     */
    async awaitCallback(opts: AwaitCallbackOptions): Promise<CallbackResult> {
        if (!this.server) {
            throw new McpSavvyError(
                'CALLBACK_PORT_BUSY',
                'callback server is not listening; call listen() first',
            );
        }
        const server = this.server;
        const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        return new Promise<CallbackResult>((resolve, reject) => {
            let settled = false;
            const finish = (action: () => void) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                server.removeListener('request', handler);
                action();
            };
            const handler = (req: IncomingMessage, res: ServerResponse): void => {
                this.handleRequest(req, res, opts.state, {
                    onSuccess: (result) => finish(() => resolve(result)),
                    onError: (err) => finish(() => reject(err)),
                });
            };
            server.on('request', handler);
            const timer = setTimeout(() => {
                finish(() =>
                    reject(
                        new AuthError(
                            'AUTH_TIMEOUT',
                            `no callback received within ${timeoutMs}ms`,
                        ),
                    ),
                );
            }, timeoutMs);
        }).finally(async () => {
            await this.stop();
        });
    }

    /** Close the listener. Safe to call repeatedly. */
    async stop(): Promise<void> {
        if (!this.server) return;
        const server = this.server;
        this.server = null;
        this.boundPort = null;
        await new Promise<void>((resolve) => server.close(() => resolve()));
        this.logger?.debug('callback server stopped');
    }

    /** Route + validate a single request. Closes the response itself. */
    private handleRequest(
        req: IncomingMessage,
        res: ServerResponse,
        expectedState: string,
        cb: { onSuccess(r: CallbackResult): void; onError(e: Error): void },
    ): void {
        const port = this.boundPort ?? this.requestedPort;
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        if (req.method !== 'GET' || url.pathname !== this.expectedPath) {
            this.send404(res);
            return;
        }
        const params = url.searchParams;
        const returnedState = params.get('state') ?? '';
        if (!timingSafeEqualString(returnedState, expectedState)) {
            this.sendErrorPage(
                res,
                'Security check failed',
                'State mismatch — possible CSRF attempt.',
            );
            return;
        }
        const error = params.get('error');
        if (error) {
            const description = params.get('error_description') ?? '';
            this.sendErrorPage(res, 'Authentication failed', error, description);
            cb.onError(new AuthError('AUTH_PROVIDER_ERROR', `IdP returned ${error}`));
            return;
        }
        const code = params.get('code') ?? '';
        if (!code) {
            this.sendErrorPage(res, 'Missing parameter', 'Authorization code is missing.');
            cb.onError(new AuthError('AUTH_PROVIDER_ERROR', 'callback missing code'));
            return;
        }
        this.sendPage(res, 200, {
            kind: 'success',
            title: 'Signed in',
            message: 'You can close this tab and return to your terminal.',
        });
        cb.onSuccess({ code, state: returnedState });
    }

    private send404(res: ServerResponse): void {
        this.sendPage(res, 404, {
            kind: 'warning',
            title: 'Not found',
            message: 'This URL is not part of the sign-in flow.',
        });
    }

    private sendErrorPage(
        res: ServerResponse,
        title: string,
        message: string,
        detail?: string,
    ): void {
        const input: CallbackPageInput = { kind: 'error', title, message };
        if (detail !== undefined) input.detail = detail;
        this.sendPage(res, 400, input);
    }

    private sendPage(
        res: ServerResponse,
        status: number,
        input: Omit<CallbackPageInput, 'brandName'>,
    ): void {
        const fullInput: CallbackPageInput = { ...input };
        if (this.brandName !== undefined) fullInput.brandName = this.brandName;
        const body = renderCallbackPage(fullInput);
        res.writeHead(status, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
            'x-frame-options': 'DENY',
        });
        res.end(body);
    }
}

/**
 * Constant-time string compare. Returns false for length mismatches
 * before doing the byte-level compare, which is fine — we only need
 * to defend against per-byte timing leaks of the actual state value.
 */
function timingSafeEqualString(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
