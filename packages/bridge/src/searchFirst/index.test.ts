/**
 * Unit tests for the request-side of `search-first` covering
 * gateway mode, call rewriting, and passthrough. Local-mode
 * filtering tests live in `requestSideLocal.test.ts`; response-side
 * `tools/list` rewriting in `responseSide.test.ts`.
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
                name: GATEWAY_SEARCH_TOOL,
                description: "Gateway's built-in semantic search.",
                inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
            },
        ],
    },
};

describe('search-first request side — gateway mode', () => {
    it('rewrites ${prefix}_search to the gateway built-in search tool', async () => {
        const ix = searchFirstInterceptors({ mode: 'gateway' });
        const action = await ix.request({
            request: {
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/call',
                params: { name: 'mcp_savvy_search', arguments: { query: 'list repos' } },
            },
        });
        expect(action.kind).toBe('replace');
        if (action.kind !== 'replace') return;
        const params = (action.message as {
            params: { name: string; arguments: { query: string } };
        }).params;
        expect(params.name).toBe(GATEWAY_SEARCH_TOOL);
        expect(params.arguments).toEqual({ query: 'list repos' });
    });

    it('rejects missing `query` in gateway mode', async () => {
        const ix = searchFirstInterceptors({ mode: 'gateway' });
        const action = await ix.request({
            request: {
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/call',
                params: { name: 'mcp_savvy_search', arguments: {} },
            },
        });
        expect(action.kind).toBe('swallow');
        if (action.kind !== 'swallow') return;
        const err = (action.respond as { error: { code: number; message: string } }).error;
        expect(err.code).toBe(-32602);
    });
});

describe('search-first request side — call rewriting', () => {
    it('rewrites ${prefix}_call to a direct tools/call with the underlying name', async () => {
        const ix = searchFirstInterceptors({ mode: 'gateway' });
        // Prime the cache so the validator passes.
        await ix.response({
            response: UPSTREAM_TOOLS_LIST_RESP,
            originalRequest: TOOLS_LIST_REQ,
        });
        const action = await ix.request({
            request: {
                jsonrpc: '2.0',
                id: 4,
                method: 'tools/call',
                params: {
                    name: 'mcp_savvy_call',
                    arguments: {
                        tool_name: 'github___listUserRepos',
                        arguments: { per_page: 10 },
                    },
                },
            },
        });
        expect(action.kind).toBe('replace');
        if (action.kind !== 'replace') return;
        const params = (action.message as {
            params: { name: string; arguments: unknown };
        }).params;
        expect(params.name).toBe('github___listUserRepos');
        expect(params.arguments).toEqual({ per_page: 10 });
    });

    it('rejects unknown tool_name with InvalidParams once the cache is populated', async () => {
        const ix = searchFirstInterceptors({ mode: 'gateway' });
        await ix.response({
            response: UPSTREAM_TOOLS_LIST_RESP,
            originalRequest: TOOLS_LIST_REQ,
        });
        const action = await ix.request({
            request: {
                jsonrpc: '2.0',
                id: 5,
                method: 'tools/call',
                params: {
                    name: 'mcp_savvy_call',
                    arguments: { tool_name: 'nope___invented', arguments: {} },
                },
            },
        });
        expect(action.kind).toBe('swallow');
        if (action.kind !== 'swallow') return;
        const err = (action.respond as { error: { code: number; message: string } }).error;
        expect(err.code).toBe(-32602);
        expect(err.message).toContain('unknown tool');
    });

    it('passes through unknown names while the cache is empty (pre-list)', async () => {
        // Without a cache snapshot we trust the model; if it's wrong
        // the gateway will return its own error.
        const ix = searchFirstInterceptors({ mode: 'gateway' });
        const action = await ix.request({
            request: {
                jsonrpc: '2.0',
                id: 6,
                method: 'tools/call',
                params: {
                    name: 'mcp_savvy_call',
                    arguments: { tool_name: 'whatever', arguments: {} },
                },
            },
        });
        expect(action.kind).toBe('replace');
    });

    it('rejects missing arguments object', async () => {
        const ix = searchFirstInterceptors({ mode: 'gateway' });
        const action = await ix.request({
            request: {
                jsonrpc: '2.0',
                id: 7,
                method: 'tools/call',
                params: {
                    name: 'mcp_savvy_call',
                    arguments: { tool_name: 'github___listUserRepos' },
                },
            },
        });
        expect(action.kind).toBe('swallow');
    });
});

describe('search-first request side — passthrough', () => {
    it('forwards tools/call for tools that are not the synthetic ones', async () => {
        const ix = searchFirstInterceptors({ mode: 'gateway' });
        const action = await ix.request({
            request: {
                jsonrpc: '2.0',
                id: 8,
                method: 'tools/call',
                params: { name: 'github___listUserRepos', arguments: {} },
            },
        });
        expect(action).toEqual({ kind: 'forward' });
    });

    it('forwards non-tools/call requests', async () => {
        const ix = searchFirstInterceptors({ mode: 'gateway' });
        const action = await ix.request({
            request: { jsonrpc: '2.0', id: 9, method: 'ping', params: {} },
        });
        expect(action).toEqual({ kind: 'forward' });
    });

    it('forwards notifications', async () => {
        const ix = searchFirstInterceptors({ mode: 'gateway' });
        const action = await ix.request({
            request: { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
        });
        expect(action).toEqual({ kind: 'forward' });
    });
});
