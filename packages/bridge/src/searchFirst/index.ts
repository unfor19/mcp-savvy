/**
 * `search-first` tool-flattening interceptor pair.
 *
 * Replaces the upstream's full tool list with two synthetic tools
 * the host model uses to discover and invoke:
 *
 *   - `${prefix}_search`: structured discovery. In `local` mode
 *     the LLM picks a `provider` (typed enum) and/or types a free-
 *     text `query`; the bridge runs a token-OR ranked filter over
 *     the cached snapshot. In `gateway` mode the `query` is
 *     forwarded to `x_amz_bedrock_agentcore_search`.
 *   - `${prefix}_call`: invoke a tool discovered via search.
 *
 * The two interceptors share an in-process cache populated from
 * the upstream's first `tools/list` response. Once the cache is
 * warm, subsequent host `tools/list` calls are answered locally —
 * no upstream round-trip until the bridge restarts.
 *
 * See FEATURES.md for the contract and tradeoffs.
 */

import type { CachedTool, SearchFirstInterceptors, SearchFirstOptions } from './types.js';
import { DEFAULT_TOOL_PREFIX } from './types.js';
import { buildSearchFirstRequestInterceptor } from './requestSide.js';
import { buildSearchFirstResponseInterceptor } from './responseSide.js';

/**
 * Build the request + response interceptors that implement
 * `search-first` mode. The two interceptors share an in-process
 * cache; both must run on the same bridge instance.
 */
export function searchFirstInterceptors(opts: SearchFirstOptions): SearchFirstInterceptors {
    const prefix = opts.prefix ?? DEFAULT_TOOL_PREFIX;
    let cache: readonly CachedTool[] = [];
    let warm = false;
    return {
        request: buildSearchFirstRequestInterceptor({
            mode: opts.mode,
            prefix,
            getCache: () => cache,
            isCacheWarm: () => warm,
        }),
        response: buildSearchFirstResponseInterceptor({
            prefix,
            mode: opts.mode,
            setCache: (tools) => {
                cache = tools;
                warm = true;
            },
        }),
    };
}

export type {
    SearchFirstMode,
    SearchFirstOptions,
    SearchFirstInterceptors,
    CachedTool,
} from './types.js';
export { DEFAULT_TOOL_PREFIX } from './types.js';
