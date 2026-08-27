/**
 * Builders for the two synthetic tools the `search-first`
 * interceptor exposes to the host, plus message-shape helpers.
 *
 * Search ranking lives in `localSearch.ts`.
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { SearchFirstMode, SyntheticListInput } from './types.js';
import { PROVIDER_DELIMITER } from './types.js';
import type { SearchResult } from './localSearch.js';

/** Tool-name suffix for the search synthetic tool. */
export const SEARCH_SUFFIX = 'search';
/** Tool-name suffix for the call synthetic tool. */
export const CALL_SUFFIX = 'call';

/**
 * Build the synthetic `${prefix}_search` tool descriptor. In
 * `local` mode the schema exposes a typed `provider` enum +
 * free-text `query` so the LLM brings the semantics; in `gateway`
 * mode the schema is just `{ query }` since the gateway's
 * semantic index does the work.
 */
export function buildSearchTool(
    prefix: string,
    mode: SearchFirstMode,
    providers: readonly string[],
): unknown {
    return mode === 'local'
        ? buildLocalSearchTool(prefix, providers)
        : buildGatewaySearchTool(prefix, providers);
}

/** `local` mode: typed provider + optional free-text query. */
function buildLocalSearchTool(prefix: string, providers: readonly string[]): unknown {
    const providerHint = renderProviderHint(providers, `\`${prefix}_${CALL_SUFFIX}\``);
    return {
        name: `${prefix}_${SEARCH_SUFFIX}`,
        description:
            'Filter the upstream tool catalog. Pass `provider` to scope to ' +
            'one provider, `query` for a token-OR ranked match against tool ' +
            'name + description (case-insensitive, camelCase-aware), or both. ' +
            'Returns matching tools with full input schemas inline; each tool ' +
            'carries `_score` (number of query tokens matched) and the ' +
            'response includes `_query_tokens` (total query tokens) so you ' +
            `can read e.g. \`3 / 3\` as a perfect match. Call them via ` +
            `\`${prefix}_${CALL_SUFFIX}\`. Both args are optional — omit both ` +
            'to list every cached tool.' +
            providerHint,
        inputSchema: buildLocalSearchSchema(providers),
    };
}

/** `gateway` mode: free-text query only — gateway's index handles the rest. */
function buildGatewaySearchTool(prefix: string, providers: readonly string[]): unknown {
    const providerHint = renderProviderHint(providers, `\`${prefix}_${CALL_SUFFIX}\``);
    return {
        name: `${prefix}_${SEARCH_SUFFIX}`,
        description:
            'Search the upstream tool catalog by natural-language query. ' +
            'Returns matching tools with their full input schemas inline so ' +
            `you can call them via \`${prefix}_${CALL_SUFFIX}\`. Always run ` +
            'a search before calling so you have the right tool name and ' +
            'argument shape.' +
            providerHint,
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description:
                        'Natural-language description of what you want to do. ' +
                        'Example: "list my GitHub repositories" or ' +
                        '"send a Slack message".',
                },
            },
            required: ['query'],
        },
    };
}

/**
 * JSON Schema for `${prefix}_search` in `local` mode. `provider`
 * carries an `enum` only when we have providers — otherwise we'd
 * emit an empty enum, which most schema validators reject.
 */
function buildLocalSearchSchema(providers: readonly string[]): unknown {
    const providerProp =
        providers.length > 0
            ? {
                type: 'string',
                enum: [...providers],
                description:
                    'Restrict results to one provider. The enum lists ' +
                    'every provider discovered in the upstream catalog.',
            }
            : {
                type: 'string',
                description:
                    'Restrict results to one provider (no providers ' +
                    'detected in the upstream catalog yet).',
            };
    return {
        type: 'object',
        properties: {
            provider: providerProp,
            query: {
                type: 'string',
                description:
                    'Natural-language query. Tokenized and matched against ' +
                    "each tool's name + description; tools are ranked by " +
                    'how many query tokens they match.',
            },
        },
    };
}

/** Build the synthetic `${prefix}_call` tool descriptor. */
export function buildCallTool(prefix: string, providers: readonly string[]): unknown {
    const providerHint = renderProviderHint(providers, `\`${prefix}_${SEARCH_SUFFIX}\``);
    return {
        name: `${prefix}_${CALL_SUFFIX}`,
        description:
            `Invoke a tool discovered via \`${prefix}_${SEARCH_SUFFIX}\`. ` +
            'Pass `tool_name` from the search result and `arguments` matching ' +
            "the tool's input schema. The bridge translates this to a direct " +
            'tool call against the upstream.' +
            providerHint,
        inputSchema: {
            type: 'object',
            properties: {
                tool_name: {
                    type: 'string',
                    description:
                        'Exact name of the tool to call, as returned by ' +
                        `\`${prefix}_${SEARCH_SUFFIX}\`.`,
                },
                arguments: {
                    type: 'object',
                    description:
                        "Arguments matching the chosen tool's input schema. " +
                        'Pass an empty object `{}` if the tool takes no inputs.',
                    additionalProperties: true,
                },
            },
            required: ['tool_name', 'arguments'],
        },
    };
}

/**
 * Append a "Available providers: ..." sentence to a tool description.
 * Empty list → empty string (the bridge hasn't sniffed `tools/list`
 * yet, or the upstream really has no scoped providers).
 */
function renderProviderHint(providers: readonly string[], partnerToolRef: string): string {
    if (providers.length === 0) return '';
    return ` Available providers: ${providers.join(', ')}. Use ${partnerToolRef} once you know which one applies.`;
}

/**
 * Synthesize the two-tool `tools/list` response we return to the
 * host. Returns a JSON-RPC result message keyed off the request id
 * the host sent so it correlates back cleanly. `providers` is
 * baked into both tool descriptions as a navigation hint for the
 * model and, in `local` mode, surfaced as the `provider`
 * input-schema enum.
 */
export function buildSyntheticListResponse(input: SyntheticListInput): JSONRPCMessage {
    return {
        jsonrpc: '2.0',
        id: input.id,
        result: {
            tools: [
                buildSearchTool(input.prefix, input.mode, input.providers),
                buildCallTool(input.prefix, input.providers),
            ],
        },
    };
}

/**
 * Derive a sorted, de-duplicated list of provider names from the
 * upstream tool list. Substring before `___` is the provider; tools
 * without the delimiter and AgentCore internals (`x_amz_*`) are
 * skipped.
 */
export function extractProviders(
    tools: readonly { readonly name: string }[],
    delimiter = PROVIDER_DELIMITER,
): string[] {
    const set = new Set<string>();
    for (const tool of tools) {
        const idx = tool.name.indexOf(delimiter);
        if (idx <= 0) continue;
        const provider = tool.name.slice(0, idx);
        if (provider.startsWith('x_amz_')) continue;
        set.add(provider);
    }
    return [...set].sort();
}

/**
 * Render a SearchResult into the JSON-RPC result message the host
 * receives. Mirrors the gateway's `x_amz_bedrock_agentcore_search`
 * shape, with two mcp-savvy-specific fields: `note` (set when a
 * tiered fallback fired so the LLM can refine on the next call)
 * and the `matched_*` echoes (set when the host actually passed
 * those args).
 */
export function buildSearchResultMessage(
    id: string | number,
    result: SearchResult,
): JSONRPCMessage {
    const payload: Record<string, unknown> = { tools: result.tools };
    if (result.queryTokens !== undefined) payload['_query_tokens'] = result.queryTokens;
    if (result.note) payload['note'] = result.note;
    if (result.matched_query !== undefined) payload['matched_query'] = result.matched_query;
    if (result.matched_provider !== undefined) {
        payload['matched_provider'] = result.matched_provider;
    }
    return {
        jsonrpc: '2.0',
        id,
        result: {
            content: [{ type: 'text', text: JSON.stringify(payload) }],
            isError: false,
        },
    };
}
