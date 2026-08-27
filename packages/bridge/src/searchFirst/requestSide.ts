/**
 * Outbound (host→remote) rewriting for `search-first` mode.
 *
 * Three cases on `tools/call`:
 *   1. `${prefix}_search` + mode: 'local'  → swallow, answer from
 *      cache. Both `provider` (optional, typed enum) and `query`
 *      (optional, free-text token-ranked) come from the host LLM;
 *      tiered fallback so the LLM never sees a bare empty list.
 *   2. `${prefix}_search` + mode: 'gateway' → rewrite to the
 *      gateway's built-in `x_amz_bedrock_agentcore_search`
 *      (free-text `query` required).
 *   3. `${prefix}_call`  → rewrite to a direct `tools/call` against
 *      the underlying tool name. Validates the tool name against the
 *      cache; surfaces a JSON-RPC InvalidParams error if unknown so
 *      the model gets a clean retry signal.
 *
 * Plus: cache-served `tools/list`. Once the cache is warm, the
 * bridge answers `tools/list` from cache (no upstream round-trip)
 * with the two synthetic tools. Restart the bridge to refresh.
 *
 * All other host frames pass through.
 */

import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import { isJSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestAction, RequestInterceptor } from '../interceptors/request.js';
import { asInterceptorFailure } from '../interceptors/wrapError.js';
import type { CachedTool, SearchFirstMode } from './types.js';
import { GATEWAY_SEARCH_TOOL, SEARCH_FIRST_INVALID_PARAMS } from './types.js';
import {
    CALL_SUFFIX,
    SEARCH_SUFFIX,
    buildSearchResultMessage,
    buildSyntheticListResponse,
    extractProviders,
} from './syntheticTools.js';
import { localSearch } from './localSearch.js';

/** Inputs for `buildSearchFirstRequestInterceptor`. */
export interface SearchFirstRequestInput {
    readonly mode: SearchFirstMode;
    readonly prefix: string;
    /** Returns the current cache snapshot (empty until populated). */
    readonly getCache: () => readonly CachedTool[];
    /** True once the response-side has populated the cache at least once. */
    readonly isCacheWarm: () => boolean;
}

/** Build the request-side interceptor for `search-first` mode. */
export function buildSearchFirstRequestInterceptor(
    input: SearchFirstRequestInput,
): RequestInterceptor {
    const searchName = `${input.prefix}_${SEARCH_SUFFIX}`;
    const callName = `${input.prefix}_${CALL_SUFFIX}`;
    return ({ request }) => {
        try {
            return handle(request, input, searchName, callName);
        } catch (err) {
            throw asInterceptorFailure(err);
        }
    };
}

function handle(
    request: JSONRPCMessage,
    input: SearchFirstRequestInput,
    searchName: string,
    callName: string,
): RequestAction {
    if (!isJSONRPCRequest(request)) return { kind: 'forward' };

    // Cache-served tools/list: once warm, answer locally instead of
    // round-tripping to the upstream every time.
    if (request.method === 'tools/list' && input.isCacheWarm()) {
        return {
            kind: 'swallow',
            respond: buildSyntheticListResponse({
                id: request.id,
                prefix: input.prefix,
                mode: input.mode,
                providers: extractProviders(input.getCache()),
            }),
        };
    }

    if (request.method !== 'tools/call') return { kind: 'forward' };
    const params = request.params as
        | { name?: unknown; arguments?: unknown; _meta?: unknown }
        | undefined;
    const name = params?.name;
    if (typeof name !== 'string') return { kind: 'forward' };

    if (name === searchName) {
        return handleSearch(request, input);
    }
    if (name === callName) {
        return handleCall(request, input);
    }
    return { kind: 'forward' };
}

function handleSearch(
    request: JSONRPCRequest,
    input: SearchFirstRequestInput,
): RequestAction {
    const params = (request.params ?? {}) as {
        arguments?: { provider?: unknown; query?: unknown };
    };
    const rawProvider = params.arguments?.provider;
    const rawQuery = params.arguments?.query;
    if (input.mode === 'local') {
        if (rawProvider !== undefined && typeof rawProvider !== 'string') {
            return invalidParams(request.id, '`provider` must be a string when present');
        }
        if (rawQuery !== undefined && typeof rawQuery !== 'string') {
            return invalidParams(request.id, '`query` must be a string when present');
        }
        const cache = input.getCache();
        const known = extractProviders(cache);
        const result = localSearch(
            cache,
            {
                ...(typeof rawProvider === 'string' ? { provider: rawProvider } : {}),
                ...(typeof rawQuery === 'string' ? { query: rawQuery } : {}),
            },
            known,
        );
        return { kind: 'swallow', respond: buildSearchResultMessage(request.id, result) };
    }
    // Gateway mode: free-text query required, forward to the gateway.
    if (typeof rawQuery !== 'string') {
        return invalidParams(request.id, '`query` (string) is required');
    }
    return {
        kind: 'replace',
        message: {
            ...request,
            params: {
                ...request.params,
                name: GATEWAY_SEARCH_TOOL,
                arguments: { query: rawQuery },
            },
        },
    };
}

function handleCall(
    request: JSONRPCRequest,
    input: SearchFirstRequestInput,
): RequestAction {
    const params = (request.params ?? {}) as {
        arguments?: { tool_name?: unknown; arguments?: unknown };
    };
    const toolName = params.arguments?.tool_name;
    const toolArgs = params.arguments?.arguments;
    if (typeof toolName !== 'string') {
        return invalidParams(request.id, '`tool_name` (string) is required');
    }
    if (typeof toolArgs !== 'object' || toolArgs === null) {
        return invalidParams(request.id, '`arguments` (object) is required');
    }
    const cache = input.getCache();
    if (cache.length > 0 && !cache.some((t) => t.name === toolName)) {
        return invalidParams(
            request.id,
            `unknown tool: ${toolName}. Run \`${input.prefix}_${SEARCH_SUFFIX}\` first to discover available tools.`,
        );
    }
    return {
        kind: 'replace',
        message: {
            ...request,
            params: {
                ...request.params,
                name: toolName,
                arguments: toolArgs,
            },
        },
    };
}

/** Synthesize a JSON-RPC InvalidParams error response for the host. */
function invalidParams(id: string | number, message: string): RequestAction {
    return {
        kind: 'swallow',
        respond: {
            jsonrpc: '2.0',
            id,
            error: {
                code: SEARCH_FIRST_INVALID_PARAMS,
                message,
            },
        },
    };
}
