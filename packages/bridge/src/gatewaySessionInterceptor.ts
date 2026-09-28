/**
 * `ResponseInterceptor` factory for AgentCore OAuth completion.
 *
 * AgentCore can request interactive authorization in two forms:
 *   - Gateway targets return JSON-RPC error `-32042` with a URL elicitation.
 *   - AWS for SAP Runtime tools return a successful JSON-RPC result whose
 *     structured data contains `requires_user_action` and `auth_url`.
 *
 * For either form, the bridge:
 *   1. Detects the authorization URL on a response to `tools/call`.
 *   2. Runs `completeGatewaySession(...)`, which starts the loopback listener
 *      before opening the browser and completes the AgentCore session.
 *   3. Retries the original tool call after the user-specific token is stored.
 *
 * The factory is intentionally pure: deployment-specific endpoints, tokens,
 * browser behavior, and logging are supplied by the caller.
 */

import {
    completeGatewaySession,
    type CompleteGatewaySessionInput,
} from '@mcp-savvy/auth';
import type { AuthorizeBrowser, Logger } from '@mcp-savvy/core';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
    isJSONRPCErrorResponse,
    isJSONRPCResultResponse,
} from '@modelcontextprotocol/sdk/types.js';
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
     * is currently using to talk to AgentCore. Called once per
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

/** Transparently complete AgentCore URL authorization and retry the tool call. */
export function gatewaySessionInterceptor(
    input: GatewaySessionInterceptorInput,
): ResponseInterceptor {
    const complete = input.completeSession ?? completeGatewaySession;
    return async ({ response, originalRequest, retryAvailable }): Promise<ResponseAction> => {
        try {
            const elicitation = extractElicitation(response);
            if (!elicitation) return { kind: 'forward' };
            if (!isToolsCall(originalRequest)) {
                input.logger?.warn(
                    'AgentCore emitted URL authorization without a matching tools/call; forwarding',
                );
                return { kind: 'forward' };
            }
            if (retryAvailable === false) {
                input.logger?.warn(
                    'AgentCore emitted URL authorization after the retry budget was exhausted; forwarding',
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
                input.logger?.info('OAuth completion succeeded; retrying original tool call');
                return { kind: 'retry' };
            } catch (err) {
                input.logger?.error(
                    `OAuth completion failed; forwarding original response: ${(err as Error).message}`,
                );
                return { kind: 'forward' };
            }
        } catch (err) {
            throw asInterceptorFailure(err);
        }
    };
}

/** Minimal authorization URL extracted from an AgentCore response. */
interface UrlElicitation {
    readonly url: string;
}

/** Extract either a Gateway error elicitation or Runtime user-action result. */
function extractElicitation(msg: JSONRPCMessage): UrlElicitation | null {
    return extractGatewayElicitation(msg) ?? extractRuntimeElicitation(msg);
}

/** Extract the first URL-mode elicitation from a Gateway error response. */
function extractGatewayElicitation(msg: JSONRPCMessage): UrlElicitation | null {
    if (!isJSONRPCErrorResponse(msg)) return null;
    if (msg.error.code !== URL_ELICITATION_REQUIRED) return null;
    const data = asRecord(msg.error.data);
    const list = data?.['elicitations'];
    if (!Array.isArray(list) || list.length === 0) return null;
    const first = asRecord(list[0]);
    const mode = first?.['mode'];
    const url = first?.['url'];
    if (mode !== 'url' || typeof url !== 'string' || url.length === 0) return null;
    return { url };
}

/** Extract AWS for SAP Runtime's structured interactive-authorization result. */
function extractRuntimeElicitation(msg: JSONRPCMessage): UrlElicitation | null {
    if (!isJSONRPCResultResponse(msg)) return null;
    const result = asRecord(msg.result);
    const structuredContent = asRecord(result?.['structuredContent']);
    const nestedToolResult = asRecord(structuredContent?.['result']);
    const toolResult = nestedToolResult ?? structuredContent;
    const data = asRecord(toolResult?.['data']);
    if (data?.['requires_user_action'] !== true) return null;
    const url = data['auth_url'];
    return typeof url === 'string' && url.length > 0 ? { url } : null;
}

/** Narrow untrusted extension data to a non-array object. */
function asRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

/** True if the original host request was a `tools/call`. */
function isToolsCall(msg: JSONRPCMessage | undefined): boolean {
    if (!msg) return false;
    const method = (msg as { method?: unknown }).method;
    return method === 'tools/call';
}
