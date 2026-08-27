/**
 * Second-leg 3LO completion for AgentCore Gateway.
 *
 * When a Gateway tool needs a third-party OAuth token (GitHub, Slack,
 * etc.), AgentCore Identity returns an `authorization_url` to the
 * caller. The bridge:
 *   1. Opens the user's browser at that URL.
 *   2. Listens on a separate loopback port (33424 by default) for
 *      AgentCore's redirect carrying `session_id`.
 *   3. POSTs `{ sessionUri }` to the deployed
 *      `OAuthCompleteSessionApi` (Bearer JWT). The API's Lambda calls
 *      AgentCore Identity's `CompleteResourceTokenAuth` server-side.
 *
 * This module is the bridge-side primitive for steps 2-3. Step 1 is
 * a one-line `openBrowser(url)` call by the caller. The bridge-level
 * orchestration (detecting the `authorization_url` in a tool result,
 * retrying the original tool call after completion) lives in the
 * bridge package — this module is intentionally MCP-agnostic.
 *
 * Threat model parity with the first-leg `CallbackServer`:
 *   - Always binds to `127.0.0.1` (never `0.0.0.0`).
 *   - Self-closes only after AgentCore validates the callback or on timeout.
 *   - Hard timeout default 5 minutes (matches first leg).
 *   - All HTML responses set `cache-control: no-store`,
 *     `referrer-policy: no-referrer`, `x-content-type-options: nosniff`,
 *     `x-frame-options: DENY`.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuthorizeBrowser, Logger } from '@mcp-savvy/core';
import { AuthError } from '@mcp-savvy/core';
import type { Fetcher } from '../http.js';
import { nodeFetcher } from '../http.js';
import { awaitSessionUri, listenOnLoopback } from './loopback.js';

/** Default loopback port for the 3LO leg. Distinct from the first-leg 33423. */
export const DEFAULT_3LO_CALLBACK_PORT = 33424;
/** Default loopback path AgentCore Identity redirects to. */
export const DEFAULT_3LO_CALLBACK_PATH = '/oauth2/callback';
/** Hard timeout for the 3LO callback. Matches the first-leg PKCE timeout. */
const DEFAULT_3LO_TIMEOUT_MS = 300_000;

/** Inputs for `completeGatewaySession`. */
export interface CompleteGatewaySessionInput {
    /**
     * The URL AgentCore Identity returned in the gateway's tool
     * response. The user is sent here to authorize the third-party
     * provider; AgentCore redirects them back to our loopback when
     * consent completes.
     */
    readonly authorizationUrl: string;
    /**
     * The deployed `OAuthCompleteSessionApi` POST endpoint. Read from
     * `MCP_SAVVY_COMPLETE_SESSION_URL`.
     */
    readonly completeSessionEndpoint: string;
    /**
     * The user's IdP JWT — the same Bearer token gating the gateway.
     * AgentCore Identity extracts the `sub` claim from this to bind
     * the OAuth flow to the user.
     */
    readonly userToken: string;
    /** Hook to open the user's browser at `authorizationUrl`. */
    readonly openBrowser: AuthorizeBrowser;
    /** Loopback port to listen on. Defaults to 33424. */
    readonly callbackPort?: number;
    /** Loopback path to listen on. Defaults to `/oauth2/callback`. */
    readonly callbackPath?: string;
    /** Hard timeout in ms. Defaults to 5 minutes. */
    readonly timeoutMs?: number;
    /**
     * Brand label rendered on the success / warning / error page.
     * Mirrors the first-leg `CallbackServer`'s `brandName` so end
     * users see the same identity across both legs of the flow.
     * Defaults to `MCP-SAVVY` (the same default the first leg uses).
     */
    readonly brandName?: string;
    /** Optional logger. */
    readonly logger?: Logger;
    /** Override the HTTP client (tests pass a fake; prod leaves unset). */
    readonly fetcher?: Fetcher;
}

/** Result of a successful 3LO completion. */
export interface CompleteGatewaySessionResult {
    /** The session URI AgentCore returned in the loopback redirect. */
    readonly sessionUri: string;
}

/**
 * Run the bridge-side half of an AgentCore Gateway 3LO completion.
 *
 * Listens on the loopback port, opens the browser, waits for the
 * `session_id` callback, POSTs to the complete-session API. Returns
 * once AgentCore's complete-session API responds 200; throws on any
 * failure or timeout.
 */
export async function completeGatewaySession(
    input: CompleteGatewaySessionInput,
): Promise<CompleteGatewaySessionResult> {
    const expectedSessionUri = authorizationSessionUri(input.authorizationUrl);
    if (!expectedSessionUri) {
        throw new AuthError(
            'AUTH_PROVIDER_ERROR',
            'AgentCore authorization URL is missing a valid request_uri',
        );
    }
    const port = input.callbackPort ?? DEFAULT_3LO_CALLBACK_PORT;
    const path = input.callbackPath ?? DEFAULT_3LO_CALLBACK_PATH;
    const timeoutMs = input.timeoutMs ?? DEFAULT_3LO_TIMEOUT_MS;
    const fetcher = input.fetcher ?? nodeFetcher;
    const logger = input.logger;
    const brandName = input.brandName;

    const server = createServer();
    await listenOnLoopback(server, port);
    const boundPort = (server.address() as AddressInfo).port;
    logger?.debug(`3LO callback listening on 127.0.0.1:${boundPort}${path}`);

    try {
        // Set up the session-URI promise BEFORE opening the browser
        // so the rejection handler is attached before the loopback
        // request can land. We swallow rejections with a no-op
        // attached `.catch(...)` here purely to silence Node.js's
        // "rejected without handler" warning — the original
        // rejection is still observed downstream when we await.
        const sessionUriPromise = awaitSessionUri(server, path, timeoutMs, brandName, async (uri) => {
            if (uri !== expectedSessionUri) return false;
            return postCompleteSession({
                endpoint: input.completeSessionEndpoint,
                sessionUri: uri,
                userToken: input.userToken,
                fetcher,
            });
        });
        sessionUriPromise.catch(() => undefined);
        await input.openBrowser(input.authorizationUrl);
        logger?.info('opened browser for third-party authorization');

        const sessionUri = await sessionUriPromise;
        logger?.debug('3LO callback received correlated session');

        logger?.info('3LO session completion succeeded');
        return { sessionUri };
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        logger?.debug('3LO callback server stopped');
    }
}

/** Read the one-time AgentCore session URI embedded in the URL we open. */
function authorizationSessionUri(authorizationUrl: string): string | null {
    try {
        const value = new URL(authorizationUrl).searchParams.get('request_uri');
        return value?.startsWith('urn:ietf:params:oauth:request_uri:') ? value : null;
    } catch {
        return null;
    }
}

interface PostCompleteSessionInput {
    endpoint: string;
    sessionUri: string;
    userToken: string;
    fetcher: Fetcher;
}

/** Validate and consume a session URI through the authenticated completion API. */
async function postCompleteSession(input: PostCompleteSessionInput): Promise<boolean> {
    const res = await input.fetcher.fetch({
        method: 'POST',
        url: input.endpoint,
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${input.userToken}`,
        },
        body: JSON.stringify({
            sessionUri: input.sessionUri,
        }),
    });
    if (res.status === 200) return true;
    if (res.status === 400 || res.status === 403) return false;
    throw new AuthError(
        'AUTH_PROVIDER_ERROR',
        `complete-session endpoint returned HTTP ${res.status}`,
    );
}
