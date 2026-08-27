/**
 * `ResponseInterceptor` factory for AgentCore Gateway 3LO completion.
 *
 * When a Gateway tool needs a third-party OAuth token (GitHub,
 * Slack, etc.), AgentCore Identity returns a JSON-RPC error with
 * `code: -32042 UrlElicitationRequired` and an `error.data.elicitations`
 * array carrying the per-elicitation `{ mode: 'url', url, elicitationId }`.
 *
 * The bridge needs to:
 *   1. Detect that error shape on a response that originated from a
 *      `tools/call` request.
 *   2. Run the bridge-side half of the second-leg flow via
 *      `completeGatewaySession(...)` — opens the browser, listens
 *      for AgentCore's loopback redirect, POSTs to the deployed
 *      `OAuthCompleteSessionApi`.
 *   3. Tell the bridge to retry the original `tools/call`. By the
 *      time the retry lands at the Gateway, the user's session is
 *      bound and the third-party OAuth token is on file, so the
 *      tool call succeeds and the host sees a normal result.
 *
 * The factory is intentionally a pure function: pass it the things
 * that vary between deployments (complete-session URL, current
 * Bearer JWT supplier, browser launcher) and it returns a
 * `ResponseInterceptor` ready to plug into `StdioBridge`.
 */

import {
    completeGatewaySession,
    type CompleteGatewaySessionInput,
} from '@mcp-savvy/auth';
import type { AuthorizeBrowser, Logger } from '@mcp-savvy/core';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { isJSONRPCErrorResponse } from '@modelcontextprotocol/sdk/types.js';
import type { ResponseAction, ResponseInterceptor } from './interceptors/response.js';
import { asInterceptorFailure } from './interceptors/wrapError.js';

/**
 * MCP error code emitted by the Gateway when a tool call needs a
 * third-party OAuth handshake. Mirrors the SDK's
 * `ErrorCode.UrlElicitationRequired`.
 */
export const URL_ELICITATION_REQUIRED = -32042;

/** Inputs for `gatewaySessionInterceptor`. */
export interface GatewaySessionInterceptorInput {
    /**
     * Deployed `OAuthCompleteSessionApi` POST endpoint. From
     * `MCP_SAVVY_COMPLETE_SESSION_URL`.
     */
    readonly completeSessionEndpoint: string;
    /**
     * Returns the user's IdP JWT — the same Bearer token the bridge
     * is currently using to talk to the Gateway. Called once per
     * elicitation so a freshly refreshed token is always used.
     */
    readonly getUserToken: () => Promise<string> | string;
    /** Hook to open the user's browser at the authorization URL. */
    readonly openBrowser: AuthorizeBrowser;
    /**
     * Brand label rendered on the loopback callback page after the
     * user consents on the third-party provider. Defaults to
     * `MCP-SAVVY` to match the first-leg `CallbackServer`.
     */
    readonly brandName?: string;
    /** Optional logger. */
    readonly logger?: Logger;
    /**
     * Test seam — defaults to the real
     * `completeGatewaySession(...)` from `@mcp-savvy/auth`.
     */
    readonly completeSession?: (input: CompleteGatewaySessionInput) => Promise<unknown>;
}

/**
 * Build a `ResponseInterceptor` that transparently completes the 3LO
 * flow for AgentCore Gateway elicitation responses.
 */
export function gatewaySessionInterceptor(
    input: GatewaySessionInterceptorInput,
): ResponseInterceptor {
    const complete = input.completeSession ?? completeGatewaySession;
    return async ({ response, originalRequest }): Promise<ResponseAction> => {
        try {
            const elicitation = extractElicitation(response);
            if (!elicitation) return { kind: 'forward' };
            if (!isToolsCall(originalRequest)) {
                input.logger?.warn(
                    'gateway emitted url elicitation but no tools/call original request matched; forwarding',
                );
                return { kind: 'forward' };
            }
            try {
                const userToken = await input.getUserToken();
                await complete({
                    authorizationUrl: elicitation.url,
                    completeSessionEndpoint: input.completeSessionEndpoint,
                    userToken,
                    openBrowser: input.openBrowser,
                    ...(input.brandName !== undefined ? { brandName: input.brandName } : {}),
                    ...(input.logger ? { logger: input.logger } : {}),
                });
                input.logger?.info('3LO completion succeeded; retrying original tool call');
                return { kind: 'retry' };
            } catch (err) {
                input.logger?.error(
                    `3LO completion failed, forwarding original error: ${(err as Error).message}`,
                );
                return { kind: 'forward' };
            }
        } catch (err) {
            throw asInterceptorFailure(err);
        }
    };
}

/** Minimal shape extracted from the Gateway's elicitation payload. */
interface UrlElicitation {
    readonly url: string;
}

/**
 * Pull the first URL-mode elicitation out of a Gateway error
 * response, or return null if the message isn't one. We match the
 * SDK's `UrlElicitationRequiredError` parser: `error.data.elicitations`
 * is an array, each entry has `{ mode: 'url', url: '...' }`.
 */
function extractElicitation(msg: JSONRPCMessage): UrlElicitation | null {
    if (!isJSONRPCErrorResponse(msg)) return null;
    if (msg.error.code !== URL_ELICITATION_REQUIRED) return null;
    const data = msg.error.data;
    if (typeof data !== 'object' || data === null) return null;
    const list = (data as { elicitations?: unknown }).elicitations;
    if (!Array.isArray(list) || list.length === 0) return null;
    const first = list[0];
    if (typeof first !== 'object' || first === null) return null;
    const mode = (first as { mode?: unknown }).mode;
    const url = (first as { url?: unknown }).url;
    if (mode !== 'url' || typeof url !== 'string' || url.length === 0) return null;
    return { url };
}

/** True if the original host request was a `tools/call`. */
function isToolsCall(msg: JSONRPCMessage | undefined): boolean {
    if (!msg) return false;
    const method = (msg as { method?: unknown }).method;
    return method === 'tools/call';
}
