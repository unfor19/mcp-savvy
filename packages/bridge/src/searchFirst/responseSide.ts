/**
 * Inbound (remote→host) rewriting for `search-first` mode.
 *
 * Two responsibilities:
 *   1. When the host's first `tools/list` response arrives, sniff
 *      the upstream tool catalog into the local cache so subsequent
 *      `${prefix}_call` invocations can validate names AND so
 *      `mode: 'local'` searches have something to match against.
 *   2. Replace the response payload with the two-tool synthetic
 *      list (`${prefix}_search` + `${prefix}_call`) so the host
 *      never sees the raw upstream tool surface.
 *
 * All other inbound frames pass through.
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { isJSONRPCResponse } from '@modelcontextprotocol/sdk/types.js';
import type { ResponseAction, ResponseInterceptor } from '../interceptors/response.js';
import { asInterceptorFailure } from '../interceptors/wrapError.js';
import type { CachedTool, SearchFirstMode } from './types.js';
import { buildSyntheticListResponse, extractProviders } from './syntheticTools.js';

/** Inputs for `buildSearchFirstResponseInterceptor`. */
export interface SearchFirstResponseInput {
    readonly prefix: string;
    readonly mode: SearchFirstMode;
    /** Replace the in-memory cache with the upstream tool list. */
    readonly setCache: (tools: readonly CachedTool[]) => void;
}

/** Build the response-side interceptor for `search-first` mode. */
export function buildSearchFirstResponseInterceptor(
    input: SearchFirstResponseInput,
): ResponseInterceptor {
    return ({ response, originalRequest }) => {
        try {
            return handle(response, originalRequest, input);
        } catch (err) {
            throw asInterceptorFailure(err);
        }
    };
}

function handle(
    response: JSONRPCMessage,
    originalRequest: JSONRPCMessage | undefined,
    input: SearchFirstResponseInput,
): ResponseAction {
    if (!originalRequest) return { kind: 'forward' };
    if (!isToolsList(originalRequest)) return { kind: 'forward' };
    if (!isJSONRPCResponse(response)) return { kind: 'forward' };

    // Sniff the upstream tool list into the cache. Anything we
    // can't recognize as a tool is silently skipped — the local
    // matcher just won't return it.
    const tools = extractTools(response);
    input.setCache(tools);

    // Replace the host-facing response with the two synthetic tools.
    return {
        kind: 'replace',
        message: buildSyntheticListResponse({
            id: response.id,
            prefix: input.prefix,
            mode: input.mode,
            providers: extractProviders(tools),
        }),
    };
}

/** True if the host request was `tools/list`. */
function isToolsList(msg: JSONRPCMessage): boolean {
    if (!('method' in msg)) return false;
    return (msg as { method?: unknown }).method === 'tools/list';
}

/**
 * Pull the array of tools out of a `tools/list` result. Tolerant of
 * missing fields — only `name` is required. `inputSchema` defaults
 * to `{ type: 'object' }` when absent so a malformed upstream
 * response still renders something callable.
 */
function extractTools(response: JSONRPCMessage): CachedTool[] {
    if (!('result' in response)) return [];
    const result = (response as { result?: unknown }).result;
    if (typeof result !== 'object' || result === null) return [];
    const list = (result as { tools?: unknown }).tools;
    if (!Array.isArray(list)) return [];
    const out: CachedTool[] = [];
    for (const entry of list) {
        if (typeof entry !== 'object' || entry === null) continue;
        const e = entry as { name?: unknown; description?: unknown; inputSchema?: unknown };
        if (typeof e.name !== 'string') continue;
        const tool: CachedTool = {
            name: e.name,
            ...(typeof e.description === 'string' ? { description: e.description } : {}),
            inputSchema: e.inputSchema ?? { type: 'object' },
        };
        out.push(tool);
    }
    return out;
}
