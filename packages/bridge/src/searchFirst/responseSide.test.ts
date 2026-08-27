/**
 * Unit tests for the response-side of the `search-first` interceptor
 * pair — the `tools/list` rewrite that replaces upstream tools with
 * the two synthetic ones, threads providers into descriptions, and
 * (in `local` mode) bakes the provider enum into the search-tool
 * input schema.
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

interface SchemaShape {
    properties?: Record<string, { type?: string; enum?: string[] }>;
    required?: string[];
}

describe('tools/list rewriting', () => {
    it('replaces the upstream tools list with the two synthetic tools', async () => {
        const ix = searchFirstInterceptors({ mode: 'gateway' });
        const action = await ix.response({
            response: UPSTREAM_TOOLS_LIST_RESP,
            originalRequest: TOOLS_LIST_REQ,
        });
        expect(action.kind).toBe('replace');
        if (action.kind !== 'replace') return;
        const result = (action.message as { result: { tools: { name: string }[] } }).result;
        expect(result.tools.map((t) => t.name)).toEqual(['mcp_savvy_search', 'mcp_savvy_call']);
    });

    it('bakes a sorted, de-duplicated provider list into both tool descriptions', async () => {
        const ix = searchFirstInterceptors({ mode: 'gateway' });
        const upstream: JSONRPCMessage = {
            jsonrpc: '2.0',
            id: 1,
            result: {
                tools: [
                    { name: 'github___listUserRepos', description: '', inputSchema: {} },
                    { name: 'github___getAuthenticatedUser', description: '', inputSchema: {} },
                    { name: 'slack___postMessage', description: '', inputSchema: {} },
                    { name: 'x_amz_bedrock_agentcore_search', description: '', inputSchema: {} },
                    { name: 'getCurrentTime', description: '', inputSchema: {} },
                ],
            },
        };
        const action = await ix.response({
            response: upstream,
            originalRequest: TOOLS_LIST_REQ,
        });
        if (action.kind !== 'replace') throw new Error('expected replace');
        const tools = (action.message as { result: { tools: { description: string }[] } }).result.tools;
        // Sorted, de-duped, x_amz_* skipped, no-delimiter tools skipped.
        expect(tools[0]?.description).toContain('Available providers: github, slack.');
        expect(tools[1]?.description).toContain('Available providers: github, slack.');
    });

    it('omits the providers sentence when no providers are detected', async () => {
        const ix = searchFirstInterceptors({ mode: 'gateway' });
        const upstream: JSONRPCMessage = {
            jsonrpc: '2.0',
            id: 1,
            result: {
                tools: [
                    { name: 'getCurrentTime', description: '', inputSchema: {} },
                    { name: 'summarizeText', description: '', inputSchema: {} },
                ],
            },
        };
        const action = await ix.response({
            response: upstream,
            originalRequest: TOOLS_LIST_REQ,
        });
        if (action.kind !== 'replace') throw new Error('expected replace');
        const tools = (action.message as { result: { tools: { description: string }[] } }).result.tools;
        expect(tools[0]?.description).not.toContain('Available providers:');
        expect(tools[1]?.description).not.toContain('Available providers:');
    });

    it('honors a custom tool prefix', async () => {
        const ix = searchFirstInterceptors({ mode: 'gateway', prefix: 'acme' });
        const action = await ix.response({
            response: UPSTREAM_TOOLS_LIST_RESP,
            originalRequest: TOOLS_LIST_REQ,
        });
        if (action.kind !== 'replace') throw new Error('expected replace');
        const result = (action.message as { result: { tools: { name: string }[] } }).result;
        expect(result.tools.map((t) => t.name)).toEqual(['acme_search', 'acme_call']);
    });

    it('local-mode search-tool schema exposes typed `provider` enum + free-text `query`', async () => {
        const ix = searchFirstInterceptors({ mode: 'local' });
        const action = await ix.response({
            response: UPSTREAM_TOOLS_LIST_RESP,
            originalRequest: TOOLS_LIST_REQ,
        });
        if (action.kind !== 'replace') throw new Error('expected replace');
        const tools = (action.message as {
            result: { tools: { name: string; inputSchema: SchemaShape }[] };
        }).result.tools;
        const search = tools[0];
        const schema = search?.inputSchema;
        expect(schema?.properties?.provider?.enum).toEqual(['github']);
        expect(schema?.properties?.query?.type).toBe('string');
        // Both args optional in local mode — agent decides which to pass.
        expect(schema?.required ?? []).toEqual([]);
    });

    it('gateway-mode search-tool schema requires `query` and has no provider enum', async () => {
        const ix = searchFirstInterceptors({ mode: 'gateway' });
        const action = await ix.response({
            response: UPSTREAM_TOOLS_LIST_RESP,
            originalRequest: TOOLS_LIST_REQ,
        });
        if (action.kind !== 'replace') throw new Error('expected replace');
        const tools = (action.message as {
            result: { tools: { name: string; inputSchema: SchemaShape }[] };
        }).result.tools;
        const search = tools[0];
        const schema = search?.inputSchema;
        expect(schema?.properties?.provider).toBeUndefined();
        expect(schema?.required).toEqual(['query']);
    });

    it('local-mode schema omits the `provider` enum when no providers are detected', async () => {
        const ix = searchFirstInterceptors({ mode: 'local' });
        const upstream: JSONRPCMessage = {
            jsonrpc: '2.0',
            id: 1,
            result: {
                tools: [{ name: 'getCurrentTime', description: '', inputSchema: {} }],
            },
        };
        const action = await ix.response({
            response: upstream,
            originalRequest: TOOLS_LIST_REQ,
        });
        if (action.kind !== 'replace') throw new Error('expected replace');
        const tools = (action.message as {
            result: { tools: { name: string; inputSchema: SchemaShape }[] };
        }).result.tools;
        // Property still exists (so the agent can still send a value),
        // but the enum is gone — empty enums are usually rejected by validators.
        expect(tools[0]?.inputSchema?.properties?.provider?.enum).toBeUndefined();
        expect(tools[0]?.inputSchema?.properties?.provider?.type).toBe('string');
    });

    it('forwards responses for non-tools/list requests unchanged', async () => {
        const ix = searchFirstInterceptors({ mode: 'gateway' });
        const otherReq: JSONRPCMessage = {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {},
        };
        const action = await ix.response({
            response: { jsonrpc: '2.0', id: 1, result: {} },
            originalRequest: otherReq,
        });
        expect(action).toEqual({ kind: 'forward' });
    });

    it('forwards responses with no matching original request', async () => {
        const ix = searchFirstInterceptors({ mode: 'gateway' });
        const action = await ix.response({
            response: UPSTREAM_TOOLS_LIST_RESP,
            originalRequest: undefined,
        });
        expect(action).toEqual({ kind: 'forward' });
    });
});
