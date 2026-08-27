/**
 * Public types for the `search-first` tool-flattening interceptor.
 *
 * Two synthetic tools (`${prefix}_search` and `${prefix}_call`)
 * replace the upstream's full tool surface. See FEATURES.md
 * for the wire shape and the comparison table.
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * Where the `${prefix}_search` synthetic tool routes the actual
 * search work.
 *
 * - `local`: the bridge filters its cached `tools/list` snapshot
 *   in-process. No upstream round-trip, no AWS billing. The host
 *   model carries the semantics: it picks a `provider` (typed
 *   enum) and/or a free-text `query`, and the bridge applies the
 *   filter deterministically. See FEATURES.md for the rationale
 *   ("the LLM brings the semantics, we bring the filter").
 * - `gateway`: the bridge forwards the search to the upstream's
 *   `x_amz_bedrock_agentcore_search` tool. Requires the gateway to
 *   have been created with `searchType: SEMANTIC` (immutable
 *   post-creation). Costs $25 / 1M queries; gateway-quality
 *   semantic match.
 */
export type SearchFirstMode = 'local' | 'gateway';

/** Inputs for `searchFirstInterceptors`. */
export interface SearchFirstOptions {
    /**
     * Where `${prefix}_search` routes. See `SearchFirstMode`.
     */
    readonly mode: SearchFirstMode;
    /**
     * Tool-name prefix. Defaults to `mcp_savvy`. Validated against
     * `^[a-z][a-z0-9_]*$` by the CLI before construction.
     */
    readonly prefix?: string;
}

/**
 * Cached tool record. The interceptor keeps just enough to
 * synthesize matches and validate `${prefix}_call` arguments.
 * `inputSchema` is preserved verbatim so search results carry the
 * full schema the model needs to construct a call.
 */
export interface CachedTool {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: unknown;
}

/** Combined output of `searchFirstInterceptors`. */
export interface SearchFirstInterceptors {
    /** Plug into `StdioBridge.requestInterceptor`. */
    readonly request: import('../interceptors/request.js').RequestInterceptor;
    /** Plug into `StdioBridge.responseInterceptor`. */
    readonly response: import('../interceptors/response.js').ResponseInterceptor;
}

/** Default tool prefix when none is supplied. */
export const DEFAULT_TOOL_PREFIX = 'mcp_savvy';

/** Built-in gateway search tool name (we forward to it in `gateway` mode). */
export const GATEWAY_SEARCH_TOOL = 'x_amz_bedrock_agentcore_search';

/** JSON-RPC error code reserved for our synthetic-call failures. */
export const SEARCH_FIRST_INVALID_PARAMS = -32602;

/**
 * Default delimiter separating provider from tool name in upstream
 * tool catalogs (AgentCore Gateway's convention).
 */
export const PROVIDER_DELIMITER = '___';

/**
 * Synthetic `tools/list` response factory. Public so tests can
 * assert it without re-running the bridge plumbing.
 */
export interface SyntheticListInput {
    readonly id: string | number;
    readonly prefix: string;
    /** Selects the search-tool input-schema variant. */
    readonly mode: SearchFirstMode;
    /**
     * Sorted list of provider names derived from the upstream
     * tool catalog. Baked into both synthetic tools' descriptions
     * as a hint for the model AND, in `local` mode, surfaced as
     * the `provider` input-schema enum on `${prefix}_search`.
     * Empty list is fine — the descriptions just omit the
     * providers sentence and the enum is omitted from the schema.
     */
    readonly providers: readonly string[];
}

/** Result of synthesizing the two-tool `tools/list` response. */
export type SyntheticListMessage = JSONRPCMessage;
