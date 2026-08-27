/**
 * MCP server Lambda for the chatgpt-app-mcp demo (Pattern D).
 *
 * Auth runs upstream at the API Gateway via a Cognito User Pool
 * Authorizer. By the time this Lambda is invoked, the JWT has
 * already been verified (signature, issuer, expiration, scope) and
 * the verified claims live in `event.requestContext.authorizer.claims`.
 * We read them directly — no JWT parsing, no JWKS fetch, no
 * `auth.mjs` in the bundle.
 *
 * Routes by HTTP path:
 *
 *   GET  /.well-known/oauth-protected-resource    public; RFC 9728
 *   GET  /.well-known/oauth-authorization-server  public; RFC 8414
 *   GET  /.well-known/openid-configuration        alias for AS metadata
 *   POST /mcp  (canonical) | / | ""               authenticated; MCP JSON-RPC dispatch
 *   POST /widgets/balance                         authenticated; widget endpoint
 *   *                                             404
 *
 * The `/` and `""` aliases for the MCP endpoint exist because
 * ChatGPT's connector-create dialog only takes a single URL; if
 * the user pastes the bare host (without `/mcp` suffix) the server
 * still accepts the call.
 *
 * `Cache-Control: no-store` and standard secure-response headers
 * are set on every dynamic response — the model + the user's
 * browser must never cache balance-adjacent data.
 */

import { dispatch } from './mcp.mjs';
import {
    buildAuthorizationServerMetadata,
    buildProtectedResourceMetadata,
} from './wellKnown.mjs';
import { handleBalanceWidget } from './widgets/balanceHandler.mjs';

const SECURE_HEADERS = Object.freeze({
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
});

/**
 * CORS headers for the well-known + MCP routes. RFC 9728 recommends
 * `Access-Control-Allow-Origin` on protected-resource metadata so
 * browser-based OAuth clients can discover the issuer. Browser-based
 * MCP inspectors send the bearer token via Authorization header.
 */
const CORS_HEADERS = Object.freeze({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version',
    'Access-Control-Max-Age': '600',
});

/** Entry point invoked by API Gateway via Lambda proxy integration. */
export async function handler(event) {
    const method = event?.httpMethod ?? '';
    const path = event?.path ?? '';
    try {
        if (method === 'OPTIONS') {
            return logged(method, path, {
                statusCode: 204,
                headers: { ...secureBaseHeaders(), ...CORS_HEADERS },
                body: '',
            });
        }

        if (method === 'GET' && path === '/.well-known/oauth-protected-resource') {
            return logged(method, path, jsonResponse(200, buildProtectedResourceMetadata(event?.headers ?? {})));
        }

        if (
            method === 'GET' &&
            (path === '/.well-known/oauth-authorization-server' ||
                path === '/.well-known/openid-configuration')
        ) {
            return logged(method, path, jsonResponse(200, buildAuthorizationServerMetadata()));
        }

        if (method === 'POST' && (path === '/mcp' || path === '/' || path === '')) {
            return logged(method, path, await handleMcp(event));
        }

        if (method === 'POST' && path === '/widgets/balance') {
            return logged(method, path, await handleWidgetBalance(event));
        }

        return logged(method, path, notFound(method, path));
    } catch (err) {
        console.error('unhandled error:', err instanceof Error ? err.stack ?? err.message : err);
        return logged(method, path, jsonResponse(500, { error: 'internal_error', message: 'Internal server error.' }));
    }
}

/** One-line per-request trace; no bodies, no claims, no headers. */
function logged(method, path, response) {
    const status = response?.statusCode ?? 0;
    console.log(`req ${method} ${path} -> ${status}`);
    return response;
}

/** Read the JSON-RPC envelope, dispatch it, return the result. */
async function handleMcp(event) {
    const claims = readClaims(event);
    if (!claims) return missingClaims();

    const body = parseJsonBody(event);
    if (body === null) {
        return jsonResponse(400, { error: 'invalid_json', message: 'Request body is not JSON.' });
    }
    console.log(`mcp method=${body?.method ?? '<missing>'} id=${body?.id ?? '<no-id>'}`);

    const isNotification = !('id' in body);
    const response = await dispatch(body, { subject: claims.sub, scopes: claims.scopes });
    if (isNotification || response === null) {
        return { statusCode: 202, headers: secureBaseHeaders(), body: '' };
    }
    return jsonResponse(200, response);
}

/** Redeem the secure_view_ref, return the widget-only balance. */
async function handleWidgetBalance(event) {
    const claims = readClaims(event);
    if (!claims) return missingClaims();

    const body = parseJsonBody(event);
    if (body === null) {
        return jsonResponse(400, { error: 'invalid_json', message: 'Request body is not JSON.' });
    }
    const result = await handleBalanceWidget({ body, claims });
    return jsonResponse(result.statusCode, result.body);
}

/**
 * Read API-Gateway-validated Cognito claims off the event. Returns
 * `null` if claims are missing — meaning the Lambda was invoked
 * outside the API Gateway path. We fail closed on that.
 */
function readClaims(event) {
    const claims = event?.requestContext?.authorizer?.claims;
    if (!claims || typeof claims !== 'object') return null;
    const sub = typeof claims.sub === 'string' ? claims.sub : '';
    if (!sub) return null;
    return {
        sub,
        email: typeof claims.email === 'string' ? claims.email : undefined,
        scopes: parseScopes(claims),
    };
}

/** API Gateway's `scope` claim is a space-separated string. */
function parseScopes(claims) {
    const out = new Set();
    if (typeof claims.scope === 'string') {
        for (const s of claims.scope.split(/\s+/)) if (s) out.add(s);
    }
    return out;
}

/**
 * Fail-closed response when the request didn't come through the
 * API Gateway path. Defensive — should never happen in production
 * because the Lambda's IAM principal only allows API-Gateway-driven
 * invocations.
 */
function missingClaims() {
    console.error('request without API Gateway authorizer claims; rejecting');
    return jsonResponse(401, { error: 'unauthorized', message: 'Missing authorizer claims.' });
}

/** Best-effort JSON body parse; proxy-integration events use `body` + optional base64 encoding. */
function parseJsonBody(event) {
    const raw = event?.body ?? '';
    if (!raw) return null;
    const decoded = event?.isBase64Encoded
        ? Buffer.from(raw, 'base64').toString('utf8')
        : raw;
    try {
        return JSON.parse(decoded);
    } catch {
        return null;
    }
}

/** Wrap a value as the proxy-integration JSON response shape. */
function jsonResponse(statusCode, body) {
    return {
        statusCode,
        headers: {
            ...secureBaseHeaders(),
            ...CORS_HEADERS,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    };
}

/** Standard secure-response headers shared by every reply. */
function secureBaseHeaders() {
    return { ...SECURE_HEADERS };
}

/** 404 with a tiny diagnostic payload (no internals leaked). */
function notFound(method, path) {
    return jsonResponse(404, {
        error: 'not_found',
        message: `No route for ${method} ${path}.`,
    });
}
