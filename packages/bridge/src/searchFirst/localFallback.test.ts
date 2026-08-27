/**
 * Tests for the tiered fallback + warm-cache behavior in
 * `search-first` local mode. Filtering / ranking / score-shape
 * tests live in `requestSideLocal.test.ts`.
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

describe('search-first local mode — fallback tiers', () => {
    it('on a no-hit query (no provider), falls back to all tools + note', async () => {
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
                params: { name: 'mcp_savvy_search', arguments: { query: 'kubernetes' } },
            },
        });
        if (action.kind !== 'swallow') throw new Error('expected swallow');
        const text = (action.respond as unknown as SearchResp).result.content[0]?.text;
        const parsed = text
            ? (JSON.parse(text) as {
                tools: { name: string }[];
                note?: string;
                matched_query?: string;
            })
            : { tools: [] };
        // Tier 3 fallback: no provider scope → show everything.
        expect(parsed.tools.map((t) => t.name).sort()).toEqual([
            'github___getAuthenticatedUser',
            'github___listUserRepos',
            'slack___postMessage',
        ]);
        expect(parsed.note).toMatch(/matched nothing/);
        expect(parsed.matched_query).toBe('kubernetes');
    });

    it('on a no-hit query within a provider, falls back to that scope + note', async () => {
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
                    arguments: { provider: 'github', query: 'kubernetes' },
                },
            },
        });
        if (action.kind !== 'swallow') throw new Error('expected swallow');
        const text = (action.respond as unknown as SearchResp).result.content[0]?.text;
        const parsed = text
            ? (JSON.parse(text) as { tools: { name: string }[]; note?: string })
            : { tools: [] };
        expect(parsed.tools.map((t) => t.name).sort()).toEqual([
            'github___getAuthenticatedUser',
            'github___listUserRepos',
        ]);
        expect(parsed.note).toMatch(/showing all tools for 'github'/);
    });

    it('on an unknown provider, returns empty + note listing knowns', async () => {
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
                params: { name: 'mcp_savvy_search', arguments: { provider: 'guithub' } },
            },
        });
        if (action.kind !== 'swallow') throw new Error('expected swallow');
        const text = (action.respond as unknown as SearchResp).result.content[0]?.text;
        const parsed = text
            ? (JSON.parse(text) as {
                tools: unknown[];
                note?: string;
                matched_provider?: string;
            })
            : { tools: [] };
        expect(parsed.tools).toEqual([]);
        expect(parsed.note).toMatch(/unknown provider 'guithub'/);
        expect(parsed.note).toMatch(/github, slack/);
        expect(parsed.matched_provider).toBe('guithub');
    });
});

describe('search-first local mode — warm-cache tools/list', () => {
    it('serves tools/list from cache once warm — no upstream round-trip', async () => {
        const ix = searchFirstInterceptors({ mode: 'local' });
        await ix.response({
            response: UPSTREAM_TOOLS_LIST_RESP,
            originalRequest: TOOLS_LIST_REQ,
        });
        const action = await ix.request({
            request: { jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} },
        });
        expect(action.kind).toBe('swallow');
        if (action.kind !== 'swallow') return;
        const tools = (action.respond as {
            result: { tools: { name: string }[] };
        }).result.tools;
        expect(tools.map((t) => t.name)).toEqual(['mcp_savvy_search', 'mcp_savvy_call']);
    });

    it('forwards the first tools/list (cache cold) so the response can populate the cache', async () => {
        const ix = searchFirstInterceptors({ mode: 'local' });
        const action = await ix.request({
            request: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        });
        expect(action).toEqual({ kind: 'forward' });
    });
});
