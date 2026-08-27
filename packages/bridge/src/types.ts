/**
 * Public types for the stdio bridge.
 */

import type { Logger } from '@mcp-savvy/core';
import type { ResponseInterceptor } from './interceptors/response.js';
import type { RequestInterceptor } from './interceptors/request.js';

/**
 * Token provider callback. The bridge calls this each time it needs
 * to (re)connect to the remote, with `forceRefresh: true` after a
 * 401. Implementations typically wrap an `AuthProvider` + token
 * cache.
 */
export type TokenProvider = (input: { forceRefresh: boolean }) => Promise<string>;

/** Options for `StdioBridge`. */
export interface StdioBridgeOptions {
    /** Streamable-HTTP MCP endpoint. */
    remoteUrl: string;
    /** Provides a fresh access token. */
    getAccessToken: TokenProvider;
    /** Optional logger. */
    logger?: Logger;
    /**
     * How many times we'll re-establish the upstream connection on a
     * 401 before giving up. Default 1 (one retry after the initial
     * attempt).
     */
    maxReauthAttempts?: number;
    /**
     * Optional hook called once per remote→host JSON-RPC frame.
     * Default behavior forwards every frame unchanged. Used to
     * implement out-of-band flows like AgentCore Gateway 3LO
     * completion without polluting the bridge with auth concerns.
     */
    responseInterceptor?: ResponseInterceptor;
    /**
     * Optional hook called once per host→remote JSON-RPC frame.
     * Default behavior forwards every frame unchanged. Used to
     * rewrite outbound requests (e.g. translate a synthetic tool
     * name back to its real name in `search-first` tool-mode) or
     * to answer requests locally without involving the remote
     * (e.g. answer `tools/list` from a cached schema set).
     *
     * For the response interceptor's retry path, the cached
     * "original request" is the **rewritten** form — what we
     * actually sent to the remote — not what the host sent us.
     * Replays therefore replay the post-interception frame.
     */
    requestInterceptor?: RequestInterceptor;
    /**
     * Maximum times the bridge will honour `{ kind: 'retry' }` for a
     * single host request id. Stops infinite loops when the remote
     * keeps emitting the same elicitation. Default 1.
     */
    maxInterceptorRetries?: number;
    /**
     * Override the `mcp-protocol-version` header sent on every
     * outbound request. Defaults to whatever the SDK negotiates from
     * the host's `initialize` round-trip — usually `2025-06-18`.
     *
     * **Set to `2025-11-25` when talking to AgentCore Gateway with
     * 3LO OAuth targets**: the service rejects 3LO target creation
     * entirely under older protocols (`3LO authentication requires
     * MCP version 2025-11-25 or later`), and at runtime URL
     * elicitation (`UrlElicitationRequiredError`, `code: -32042`)
     * is only delivered when the wire protocol agrees.
     */
    mcpProtocolVersion?: string;
}
