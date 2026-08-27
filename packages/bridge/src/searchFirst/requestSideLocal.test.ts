/**
 * Unit tests for the request-side of `search-first` in `local`
 * mode — provider/query filtering, ranking, and `_score` shape
 * against the cached snapshot. Fallback-tier tests live in
 * `localFallback.test.ts`; gateway-mode + call-rewriting +
 * passthrough live in `index.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { searchFirstInterceptors } from './index.js';
import { GATEWAY_SEARCH_TOOL } from './types.js';

const TOOLS_LIST_REQ: JSONRPCMessage = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
};

const UPSTREAM_TOOLS_LIST_RESP: JSONRPCMessage = {
    jsonrpc: '2.0',
    id: 1,
    result: {
        tools: [
            {
                name: 'github___listUserRepos',
                description: 'Lists repositories the authenticated user can access.',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'github___getAuthenticatedUser',
                description: 'Returns the authenticated user GitHub profile.',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'slack___postMessage',
                description: 'Send a message to a Slack channel.',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: GATEWAY_SEARCH_TOOL,
                description: "Gateway's built-in semantic search.",
                inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
            },
        ],
    },
};

interface SearchResp {
    result: { content: { text: string }[] };
}

function parseToolNames(action: { kind: string; respond?: unknown }): string[] {
    if (action.kind !== 'swallow') throw new Error('expected swallow');
    const text = (action.respond as unknown as SearchResp).result.content[0]?.text;
    const parsed = text ? (JSON.parse(text) as { tools: { name: string }[] }) : { tools: [] };
    return parsed.tools.map((t) => t.name);
}

describe('search-first local mode — filtering', () => {
    it('filters by `provider` alone — returns every tool for that provider', async () => {
        const ix = searchFirstInterceptors({ mode: 'local' });
        await ix.response({
            response: UPSTREAM_TOOLS_LIST_RESP,
            originalRequest: TOOLS_LIST_REQ,
        });
        const action = await ix.request({
            request: {
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: { name: 'mcp_savvy_search', arguments: { provider: 'github' } },
            },
        });
        expect(parseToolNames(action)).toEqual([
            'github___listUserRepos',
            'github___getAuthenticatedUser',
        ]);
    });

    it('filters by `query` alone — token-OR ranked', async () => {
        const ix = searchFirstInterceptors({ mode: 'local' });
        await ix.response({
            response: UPSTREAM_TOOLS_LIST_RESP,
            originalRequest: TOOLS_LIST_REQ,
        });
        const action = await ix.request({
            request: {
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: { name: 'mcp_savvy_search', arguments: { query: 'list repos' } },
            },
        });
        // listUserRepos scores 2 (list, repos); other GitHub tool scores 0
        // because tokenizer cracks listUserRepos → [list, user, repos].
        expect(parseToolNames(action)[0]).toBe('github___listUserRepos');
    });

    it('combines provider + query — ranked match within scope', async () => {
        const ix = searchFirstInterceptors({ mode: 'local' });
        await ix.response({
            response: UPSTREAM_TOOLS_LIST_RESP,
            originalRequest: TOOLS_LIST_REQ,
        });
        const action = await ix.request({
            request: {
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: {
                    name: 'mcp_savvy_search',
                    arguments: { provider: 'github', query: 'profile' },
                },
            },
        });
        expect(parseToolNames(action)).toEqual(['github___getAuthenticatedUser']);
    });

    it('with neither argument, returns the full cached list (excluding x_amz_*)', async () => {
        const ix = searchFirstInterceptors({ mode: 'local' });
        await ix.response({
            response: UPSTREAM_TOOLS_LIST_RESP,
            originalRequest: TOOLS_LIST_REQ,
        });
        const action = await ix.request({
            request: {
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: { name: 'mcp_savvy_search', arguments: {} },
            },
        });
        expect(parseToolNames(action)).toEqual([
            'github___listUserRepos',
            'github___getAuthenticatedUser',
            'slack___postMessage',
        ]);
    });

    it('rejects non-string `provider`', async () => {
        const ix = searchFirstInterceptors({ mode: 'local' });
        const action = await ix.request({
            request: {
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: { name: 'mcp_savvy_search', arguments: { provider: 7 } },
            },
        });
        expect(action.kind).toBe('swallow');
        if (action.kind !== 'swallow') return;
        const err = (action.respond as { error: { code: number; message: string } }).error;
        expect(err.code).toBe(-32602);
        expect(err.message).toContain('provider');
    });
});

describe('search-first local mode — ranking', () => {
    it('handles natural-language queries with stop words via token-OR', async () => {
        // The exact failure case: "list my github repos". Old AND-substring
        // killed it on the stop word "my"; ranked OR scores listUserRepos high.
        const ix = searchFirstInterceptors({ mode: 'local' });
        await ix.response({
            response: UPSTREAM_TOOLS_LIST_RESP,
            originalRequest: TOOLS_LIST_REQ,
        });
        const action = await ix.request({
            request: {
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: { name: 'mcp_savvy_search', arguments: { query: 'list my github repos' } },
            },
        });
        const names = parseToolNames(action);
        expect(names[0]).toBe('github___listUserRepos');
        expect(names).toContain('github___getAuthenticatedUser');
    });

    it('annotates each ranked tool with `_score` and includes `_query_tokens`', async () => {
        const ix = searchFirstInterceptors({ mode: 'local' });
        await ix.response({
            response: UPSTREAM_TOOLS_LIST_RESP,
            originalRequest: TOOLS_LIST_REQ,
        });
        const action = await ix.request({
            request: {
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: {
                    name: 'mcp_savvy_search',
                    arguments: { query: 'list my github repos' },
                },
            },
        });
        if (action.kind !== 'swallow') throw new Error('expected swallow');
        const text = (action.respond as unknown as SearchResp).result.content[0]?.text;
        const parsed = text
            ? (JSON.parse(text) as {
                tools: { name: string; _score?: number }[];
                _query_tokens?: number;
            })
            : { tools: [] };
        expect(parsed._query_tokens).toBe(4); // list, my, github, repos
        // listUserRepos: list ✓, github ✓, repos ✓ (my doesn't appear in any
        // tokenized haystack) → score 3.
        expect(parsed.tools[0]?._score).toBeGreaterThanOrEqual(2);
        expect(parsed.tools[0]?._score).toBeGreaterThan(parsed.tools[1]?._score ?? 0);
    });
});
