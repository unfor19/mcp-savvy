/**
 * Loopback callback handling for the 3LO second-leg flow.
 *
 * Pulled out of `index.ts` to keep that file under fon's 300-line
 * limit. This module owns the HTTP listener wiring + the branded
 * page rendering; `index.ts` owns the public `completeGatewaySession`
 * primitive + the complete-session POST.
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { AuthError } from '@mcp-savvy/core';
import {
    renderCallbackPage,
    type CallbackPageInput,
    type CallbackPageKind,
} from '@mcp-savvy/server';

/** Bind the listener to loopback. Security-critical: 127.0.0.1 only. */
export function listenOnLoopback(server: Server, port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
    });
}

/**
 * Resolve only after the completion API validates and consumes `session_id`.
 * Invalid or malformed callbacks do not consume the one-shot listener.
 */
export function awaitSessionUri(
    server: Server,
    path: string,
    timeoutMs: number,
    brandName: string | undefined,
    validate: (sessionUri: string) => Promise<boolean>,
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let settled = false;
        const finishOnce = (action: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            server.removeListener('request', handler);
            action();
        };
        let validating = false;
        const handler = (req: IncomingMessage, res: ServerResponse): void => {
            void handleSessionRequest(req, res, path, brandName, {
                canValidate: () => !validating,
                onValidationStart: () => {
                    validating = true;
                },
                validate,
                onValidationEnd: () => {
                    validating = false;
                },
                onSuccess: (uri) => finishOnce(() => resolve(uri)),
                onError: (err) => finishOnce(() => reject(err)),
            });
        };
        server.on('request', handler);
        const timer = setTimeout(() => {
            finishOnce(() =>
                reject(
                    new AuthError(
                        'AUTH_TIMEOUT',
                        `no 3LO callback received within ${timeoutMs}ms`,
                    ),
                ),
            );
        }, timeoutMs);
    });
}

interface SessionCallbacks {
    canValidate(): boolean;
    onValidationStart(): void;
    validate(uri: string): Promise<boolean>;
    onValidationEnd(): void;
    onSuccess(uri: string): void;
    onError(err: Error): void;
}

/** Parse + validate one request. Always closes the response. */
async function handleSessionRequest(
    req: IncomingMessage,
    res: ServerResponse,
    expectedPath: string,
    brandName: string | undefined,
    cb: SessionCallbacks,
): Promise<void> {
    if (req.method !== 'GET') {
        sendBrandedPage(res, 405, brandName, {
            kind: 'error',
            title: 'Method Not Allowed',
            message: 'This callback only accepts GET requests.',
        });
        return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== expectedPath) {
        sendBrandedPage(res, 404, brandName, {
            kind: 'warning',
            title: 'Not Found',
            message: 'The requested page was not found.',
        });
        return;
    }
    const sessionId = url.searchParams.get('session_id');
    const error = url.searchParams.get('error');
    if (error) {
        const description = url.searchParams.get('error_description') ?? '';
        sendBrandedPage(res, 400, brandName, {
            kind: 'error',
            title: 'Authorization Error',
            message:
                'The third-party identity provider returned an error during ' +
                'authorization. You can close this tab; mcp-savvy will surface ' +
                'the error in your terminal.',
            detail: `${error}${description ? `: ${description}` : ''}`,
        });
        return;
    }
    if (!sessionId) {
        sendBrandedPage(res, 400, brandName, {
            kind: 'warning',
            title: 'Missing Session',
            message:
                'The callback URL is missing the expected `session_id` parameter. ' +
                'This usually means the authorization flow was not initiated ' +
                'through mcp-savvy.',
        });
        return;
    }
    if (!cb.canValidate()) {
        sendBrandedPage(res, 409, brandName, {
            kind: 'warning',
            title: 'Authorization Pending',
            message: 'Another callback is being checked. Please retry this authorization.',
        });
        return;
    }
    cb.onValidationStart();
    let valid: boolean;
    try {
        valid = await cb.validate(sessionId);
    } catch (err) {
        cb.onValidationEnd();
        sendBrandedPage(res, 502, brandName, {
            kind: 'error',
            title: 'Authorization Service Error',
            message: 'The authorization service could not validate this callback.',
        });
        cb.onError(err instanceof Error ? err : new Error('callback validation failed'));
        return;
    }
    cb.onValidationEnd();
    if (!valid) {
        sendBrandedPage(res, 400, brandName, {
            kind: 'warning',
            title: 'Unrecognized Authorization',
            message: 'This callback does not belong to the active authorization flow.',
        });
        return;
    }
    sendBrandedPage(res, 200, brandName, {
        kind: 'success',
        title: 'Authorization Complete',
        message: 'You can close this tab and return to your terminal.',
    });
    cb.onSuccess(sessionId);
}

/**
 * Render a branded callback page using `@mcp-savvy/server`'s
 * shared template, then close the response. Same hardening
 * headers as the first-leg `CallbackServer`.
 */
function sendBrandedPage(
    res: ServerResponse,
    status: number,
    brandName: string | undefined,
    page: { kind: CallbackPageKind; title: string; message: string; detail?: string },
): void {
    const input: CallbackPageInput = {
        kind: page.kind,
        title: page.title,
        message: page.message,
        ...(page.detail !== undefined ? { detail: page.detail } : {}),
        ...(brandName !== undefined ? { brandName } : {}),
    };
    res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
    });
    res.end(renderCallbackPage(input));
}
