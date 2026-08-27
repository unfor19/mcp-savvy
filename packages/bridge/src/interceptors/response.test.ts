/**
 * Unit tests for the bridge's response-interceptor hook. Covers
 * outbound request tracking, the four `ResponseAction` kinds, the
 * retry budget, and the unsolicited-message path.
 */

import { describe, it, expect } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { StdioBridge } from '../stdioBridge.js';
import type { ResponseAction, ResponseInterceptor } from './response.js';
import { fakeTransport, SAMPLE_REQUEST, tick } from '../testFixtures.js';

const SAMPLE_RESPONSE: JSONRPCMessage = {
    jsonrpc: '2.0',
    id: 1,
    result: { tools: [] },
};

const SAMPLE_NOTIFICATION: JSONRPCMessage = {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
};

describe('outbound request tracking', () => {
    it('passes the original request to the interceptor for matching responses', async () => {
        const host = fakeTransport();
        const remote = fakeTransport();
        const seen: { hasOriginal: boolean; method: string | undefined }[] = [];
        const interceptor: ResponseInterceptor = ({ originalRequest }) => {
            const hasOriginal = originalRequest !== undefined;
            const method =
                originalRequest && 'method' in originalRequest
                    ? (originalRequest.method as string)
                    : undefined;
            seen.push({ hasOriginal, method });
            return { kind: 'forward' };
        };
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async () => 'token',
            stdioTransport: () => host,
            remoteTransport: () => remote,
            responseInterceptor: interceptor,
        });
        const running = bridge.run();
        await tick();
        host.fireMessage(SAMPLE_REQUEST);
        await tick();
        remote.fireMessage(SAMPLE_RESPONSE);
        await tick();
        expect(seen).toEqual([{ hasOriginal: true, method: 'tools/list' }]);
        host.fireClose();
        await running;
    });

    it('passes originalRequest=undefined for unsolicited remote messages', async () => {
        const host = fakeTransport();
        const remote = fakeTransport();
        const seen: { hasOriginal: boolean }[] = [];
        const interceptor: ResponseInterceptor = ({ originalRequest }) => {
            seen.push({ hasOriginal: originalRequest !== undefined });
            return { kind: 'forward' };
        };
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async () => 'token',
            stdioTransport: () => host,
            remoteTransport: () => remote,
            responseInterceptor: interceptor,
        });
        const running = bridge.run();
        await tick();
        // Server-initiated notification, no host request preceded it.
        remote.fireMessage(SAMPLE_NOTIFICATION);
        await tick();
        expect(seen).toEqual([{ hasOriginal: false }]);
        host.fireClose();
        await running;
    });

    it('does not track host notifications', async () => {
        const host = fakeTransport();
        const remote = fakeTransport();
        const seen: { hasOriginal: boolean }[] = [];
        const interceptor: ResponseInterceptor = ({ originalRequest }) => {
            seen.push({ hasOriginal: originalRequest !== undefined });
            return { kind: 'forward' };
        };
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async () => 'token',
            stdioTransport: () => host,
            remoteTransport: () => remote,
            responseInterceptor: interceptor,
        });
        const running = bridge.run();
        await tick();
        host.fireMessage(SAMPLE_NOTIFICATION);
        await tick();
        // Now the remote sends a response with the same id 1 — it
        // must not be matched to anything because no host request
        // with id 1 was tracked.
        remote.fireMessage(SAMPLE_RESPONSE);
        await tick();
        expect(seen).toEqual([{ hasOriginal: false }]);
        host.fireClose();
        await running;
    });
});

describe('response actions', () => {
    it('swallow drops the response without forwarding to host', async () => {
        const host = fakeTransport();
        const remote = fakeTransport();
        const interceptor: ResponseInterceptor = (): ResponseAction => ({ kind: 'swallow' });
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async () => 'token',
            stdioTransport: () => host,
            remoteTransport: () => remote,
            responseInterceptor: interceptor,
        });
        const running = bridge.run();
        await tick();
        host.fireMessage(SAMPLE_REQUEST);
        await tick();
        remote.fireMessage(SAMPLE_RESPONSE);
        await tick();
        expect(host.sent).toEqual([]);
        host.fireClose();
        await running;
    });

    it('replace forwards the substitute message to the host', async () => {
        const host = fakeTransport();
        const remote = fakeTransport();
        const replacement: JSONRPCMessage = {
            jsonrpc: '2.0',
            id: 1,
            result: { replaced: true },
        };
        const interceptor: ResponseInterceptor = (): ResponseAction => ({
            kind: 'replace',
            message: replacement,
        });
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async () => 'token',
            stdioTransport: () => host,
            remoteTransport: () => remote,
            responseInterceptor: interceptor,
        });
        const running = bridge.run();
        await tick();
        host.fireMessage(SAMPLE_REQUEST);
        await tick();
        remote.fireMessage(SAMPLE_RESPONSE);
        await tick();
        expect(host.sent).toEqual([replacement]);
        host.fireClose();
        await running;
    });

    it('retry re-sends the original request to the remote', async () => {
        const host = fakeTransport();
        const remote = fakeTransport();
        let calls = 0;
        const interceptor: ResponseInterceptor = (): ResponseAction => {
            calls += 1;
            return calls === 1 ? { kind: 'retry' } : { kind: 'forward' };
        };
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async () => 'token',
            stdioTransport: () => host,
            remoteTransport: () => remote,
            responseInterceptor: interceptor,
        });
        const running = bridge.run();
        await tick();
        host.fireMessage(SAMPLE_REQUEST);
        await tick();
        // First response: interceptor returns retry, bridge re-sends.
        remote.fireMessage(SAMPLE_RESPONSE);
        await tick();
        expect(remote.sent).toEqual([SAMPLE_REQUEST, SAMPLE_REQUEST]);
        // Second response: interceptor returns forward, host gets it.
        remote.fireMessage(SAMPLE_RESPONSE);
        await tick();
        expect(host.sent).toEqual([SAMPLE_RESPONSE]);
        host.fireClose();
        await running;
    });

    it('retry budget exhausted falls back to forwarding the response', async () => {
        const host = fakeTransport();
        const remote = fakeTransport();
        const interceptor: ResponseInterceptor = (): ResponseAction => ({ kind: 'retry' });
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async () => 'token',
            stdioTransport: () => host,
            remoteTransport: () => remote,
            responseInterceptor: interceptor,
            maxInterceptorRetries: 1,
        });
        const running = bridge.run();
        await tick();
        host.fireMessage(SAMPLE_REQUEST);
        await tick();
        // First response triggers the one allowed retry.
        remote.fireMessage(SAMPLE_RESPONSE);
        await tick();
        expect(remote.sent).toEqual([SAMPLE_REQUEST, SAMPLE_REQUEST]);
        // Second response: budget exhausted, must forward.
        remote.fireMessage(SAMPLE_RESPONSE);
        await tick();
        expect(host.sent).toEqual([SAMPLE_RESPONSE]);
        host.fireClose();
        await running;
    });

    it('retry without a matching request falls back to forwarding', async () => {
        const host = fakeTransport();
        const remote = fakeTransport();
        const interceptor: ResponseInterceptor = (): ResponseAction => ({ kind: 'retry' });
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async () => 'token',
            stdioTransport: () => host,
            remoteTransport: () => remote,
            responseInterceptor: interceptor,
        });
        const running = bridge.run();
        await tick();
        // No host request preceded this — interceptor gets undefined
        // originalRequest, retry has nothing to replay.
        remote.fireMessage(SAMPLE_NOTIFICATION);
        await tick();
        expect(remote.sent).toEqual([]);
        expect(host.sent).toEqual([SAMPLE_NOTIFICATION]);
        host.fireClose();
        await running;
    });

    it('interceptor error falls back to forwarding the response', async () => {
        const host = fakeTransport();
        const remote = fakeTransport();
        const interceptor: ResponseInterceptor = () => {
            throw new Error('interceptor exploded');
        };
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async () => 'token',
            stdioTransport: () => host,
            remoteTransport: () => remote,
            responseInterceptor: interceptor,
        });
        const running = bridge.run();
        await tick();
        host.fireMessage(SAMPLE_REQUEST);
        await tick();
        remote.fireMessage(SAMPLE_RESPONSE);
        await tick();
        expect(host.sent).toEqual([SAMPLE_RESPONSE]);
        host.fireClose();
        await running;
    });
});
