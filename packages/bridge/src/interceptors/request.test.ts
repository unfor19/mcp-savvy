/**
 * Unit tests for the bridge's request-side interceptor hook.
 * Covers the three RequestActions plus the cache-after-rewrite
 * invariant that 3LO retry depends on.
 */

import { describe, it, expect } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { StdioBridge } from '../stdioBridge.js';
import type { RequestInterceptor } from './request.js';
import type { ResponseInterceptor, ResponseAction } from './response.js';
import { fakeTransport, SAMPLE_REQUEST, tick } from '../testFixtures.js';

const SAMPLE_RESPONSE: JSONRPCMessage = {
    jsonrpc: '2.0',
    id: 1,
    result: { tools: [] },
};

describe('request interceptor', () => {
    it('forward (default) sends the original request to the remote', async () => {
        const host = fakeTransport();
        const remote = fakeTransport();
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async () => 'token',
            stdioTransport: () => host,
            remoteTransport: () => remote,
        });
        const running = bridge.run();
        await tick();
        host.fireMessage(SAMPLE_REQUEST);
        await tick();
        expect(remote.sent).toEqual([SAMPLE_REQUEST]);
        host.fireClose();
        await running;
    });

    it('replace rewrites the outbound request before it hits the remote', async () => {
        const host = fakeTransport();
        const remote = fakeTransport();
        const rewritten: JSONRPCMessage = {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'real', arguments: {} },
        };
        const interceptor: RequestInterceptor = () => ({
            kind: 'replace',
            message: rewritten,
        });
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async () => 'token',
            stdioTransport: () => host,
            remoteTransport: () => remote,
            requestInterceptor: interceptor,
        });
        const running = bridge.run();
        await tick();
        host.fireMessage(SAMPLE_REQUEST);
        await tick();
        expect(remote.sent).toEqual([rewritten]);
        host.fireClose();
        await running;
    });

    it('swallow answers the host locally and never touches the remote', async () => {
        const host = fakeTransport();
        const remote = fakeTransport();
        const localResponse: JSONRPCMessage = {
            jsonrpc: '2.0',
            id: 1,
            result: { tools: [{ name: 'cached', inputSchema: { type: 'object' } }] },
        };
        const interceptor: RequestInterceptor = () => ({
            kind: 'swallow',
            respond: localResponse,
        });
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async () => 'token',
            stdioTransport: () => host,
            remoteTransport: () => remote,
            requestInterceptor: interceptor,
        });
        const running = bridge.run();
        await tick();
        host.fireMessage(SAMPLE_REQUEST);
        await tick();
        expect(remote.sent).toEqual([]);
        expect(host.sent).toEqual([localResponse]);
        host.fireClose();
        await running;
    });

    it('falls back to forward when the request interceptor throws', async () => {
        const host = fakeTransport();
        const remote = fakeTransport();
        const interceptor: RequestInterceptor = () => {
            throw new Error('interceptor exploded');
        };
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async () => 'token',
            stdioTransport: () => host,
            remoteTransport: () => remote,
            requestInterceptor: interceptor,
        });
        const running = bridge.run();
        await tick();
        host.fireMessage(SAMPLE_REQUEST);
        await tick();
        expect(remote.sent).toEqual([SAMPLE_REQUEST]);
        host.fireClose();
        await running;
    });

    it('caches the rewritten request so a response retry replays the rewritten frame', async () => {
        const host = fakeTransport();
        const remote = fakeTransport();
        const rewritten: JSONRPCMessage = {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'real', arguments: {} },
        };
        const requestInterceptor: RequestInterceptor = () => ({
            kind: 'replace',
            message: rewritten,
        });
        // Response interceptor: first response triggers a retry,
        // second response forwards. Confirms the bridge replays the
        // **rewritten** frame, not the original synthetic one.
        let calls = 0;
        const responseInterceptor: ResponseInterceptor = (): ResponseAction => {
            calls += 1;
            return calls === 1 ? { kind: 'retry' } : { kind: 'forward' };
        };
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async () => 'token',
            stdioTransport: () => host,
            remoteTransport: () => remote,
            requestInterceptor,
            responseInterceptor,
        });
        const running = bridge.run();
        await tick();
        host.fireMessage(SAMPLE_REQUEST);
        await tick();
        // Remote should have received the rewritten frame.
        expect(remote.sent).toEqual([rewritten]);
        // First response: interceptor returns retry; bridge re-sends.
        remote.fireMessage(SAMPLE_RESPONSE);
        await tick();
        // The replayed frame must be the rewritten form — never the
        // host's original synthetic call.
        expect(remote.sent).toEqual([rewritten, rewritten]);
        // Second response: forwards to host.
        remote.fireMessage(SAMPLE_RESPONSE);
        await tick();
        expect(host.sent).toEqual([SAMPLE_RESPONSE]);
        host.fireClose();
        await running;
    });
});
