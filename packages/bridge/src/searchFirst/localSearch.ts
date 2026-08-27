/**
 * Token-OR ranked search over the cached tool list, used by
 * `${prefix}_search` in `mode: 'local'`. Pure function — no
 * bridge dependencies.
 *
 * Ranking: each query token scores 1 if it appears as a case-
 * insensitive substring of any token in the tool's tokenized
 * haystack (`name + description`, cracked on whitespace +
 * camelCase + `_-.`). Tools are sorted by score descending, then
 * by name ascending for stable ordering.
 *
 * Tiered fallback so the host LLM never sees a bare empty list:
 *   1. hits           → ranked hits, no note
 *   2. no hits, scope → all tools in scope + "matched nothing" note
 *   3. unknown prov.  → empty + note listing known providers
 */

import type { CachedTool } from './types.js';
import { PROVIDER_DELIMITER } from './types.js';

/** Result of `localSearch` — the shape we hand to `buildSearchResultMessage`. */
export interface SearchResult {
    /** Tools as cached, optionally annotated with `_score` when ranked. */
    readonly tools: readonly RankedTool[];
    /**
     * Number of query tokens, when `query` was passed. Pairs with
     * each tool's `_score` so the LLM reads e.g. `3 / 3` as "matched
     * every search word." Surfaced as `_query_tokens` in the wire
     * payload — denominator semantics, not "max score in result set".
     */
    readonly queryTokens?: number;
    readonly note?: string;
    readonly matched_query?: string;
    readonly matched_provider?: string;
}

/**
 * Cached tool with an optional ranking score. `_score` is set
 * when the result came from `rankByQuery`; absent for tools
 * surfaced via fallback (no query, or fallback to scope).
 */
export interface RankedTool extends CachedTool {
    readonly _score?: number;
}

/** Execute a search against the local cache. See module doc for the contract. */
export function localSearch(
    tools: readonly CachedTool[],
    args: { readonly provider?: string; readonly query?: string },
    knownProviders: readonly string[],
): SearchResult {
    const provider = args.provider;
    const query = args.query?.trim() || undefined;

    if (provider !== undefined && !knownProviders.includes(provider)) {
        const knowns = knownProviders.length > 0 ? knownProviders.join(', ') : '(none)';
        return {
            tools: [],
            note: `unknown provider '${provider}' — known providers: ${knowns}`,
            matched_provider: provider,
            ...(query !== undefined ? { matched_query: query } : {}),
        };
    }

    const scoped = scopeByProvider(tools, provider);
    if (query === undefined) {
        return {
            tools: scoped,
            ...(provider !== undefined ? { matched_provider: provider } : {}),
        };
    }

    const queryTokens = tokenize(query);
    const ranked = rankByQuery(scoped, queryTokens);
    if (ranked.length > 0) {
        return {
            tools: ranked,
            queryTokens: queryTokens.length,
            matched_query: query,
            ...(provider !== undefined ? { matched_provider: provider } : {}),
        };
    }

    return {
        tools: scoped,
        note:
            provider !== undefined
                ? `query matched nothing; showing all tools for '${provider}'. Try a more specific query.`
                : 'query matched nothing; showing all tools. Try a more specific query or pass a `provider`.',
        matched_query: query,
        ...(provider !== undefined ? { matched_provider: provider } : {}),
    };
}

/** Filter the cache to a single provider (and skip x_amz_* always). */
function scopeByProvider(
    tools: readonly CachedTool[],
    provider: string | undefined,
): CachedTool[] {
    const prefix = provider ? `${provider}${PROVIDER_DELIMITER}` : null;
    return tools.filter((t) => {
        if (t.name.startsWith('x_amz_')) return false;
        if (prefix && !t.name.startsWith(prefix)) return false;
        return true;
    });
}

/**
 * Rank tools by token-overlap score. Score 0 → dropped. Returns
 * each surviving tool with `_score` baked in so the LLM can read
 * the match strength alongside the schema.
 */
function rankByQuery(
    tools: readonly CachedTool[],
    queryTokens: readonly string[],
): RankedTool[] {
    if (queryTokens.length === 0) return tools.map((t) => ({ ...t }));
    const scored = tools.map((tool) => {
        const haystackTokens = tokenizeIdentifier(`${tool.name} ${tool.description ?? ''}`);
        let score = 0;
        for (const qt of queryTokens) {
            if (haystackTokens.some((ht) => ht.includes(qt))) score += 1;
        }
        return { tool, score };
    });
    return scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
        .map((s) => ({ ...s.tool, _score: s.score }));
}

/** Lowercase + split on whitespace, drop empties. */
function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 0);
}

/**
 * Tokenize an identifier-bearing haystack: lowercase + split on
 * whitespace + camelCase boundaries + `_-.`. Lets `repos` match
 * `listUserRepos`, `repo` match `Repository`, etc.
 */
function tokenizeIdentifier(text: string): string[] {
    return text
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
        .split(/[\s_\-.]+/)
        .filter((w) => w.length > 0);
}
