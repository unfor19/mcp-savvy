/**
 * Unit tests for `StdioBridge`. We inject scripted `Transport`
 * implementations (no real stdio, no real HTTP) and exercise the
 * pump, the 401-reauth path, and the shutdown sequence.
 */

import { describe, it, expect } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { StdioBridge } from './stdioBridge.js';
import { fakeTransport, FakeTransport, SAMPLE_REQUEST, tick } from './testFixtures.js';

describe('happy path', () => {
    it('forwards host messages to the remote with the supplied token', async () => {
        const host = fakeTransport();
        const remote = fakeTransport();
        const tokensSeen: string[] = [];
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async () => {
                tokensSeen.push('initial');
                return 'token-1';
            },
            stdioTransport: () => host,
            remoteTransport: (token) => {
                expect(token).toBe('token-1');
                return remote;
            },
        });
        const running = bridge.run();
        await tick();
        host.fireMessage(SAMPLE_REQUEST);
        await tick();
        expect(remote.sent).toEqual([SAMPLE_REQUEST]);
        host.fireClose();
        await running;
        expect(remote.closed).toBe(true);
        expect(tokensSeen).toEqual(['initial']);
    });

    it('forwards remote messages to the host', async () => {
        const host = fakeTransport();
        const remote = fakeTransport();
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async () => 'token-1',
            stdioTransport: () => host,
            remoteTransport: () => remote,
        });
        const running = bridge.run();
        await tick();
        const response: JSONRPCMessage = { jsonrpc: '2.0', id: 1, result: { tools: [] } };
        remote.fireMessage(response);
        await tick();
        expect(host.sent).toEqual([response]);
        host.fireClose();
        await running;
    });
});

describe('reauth on 401', () => {
    it('reconnects with a fresh token when the remote errors with status 401', async () => {
        const host = fakeTransport();
        const remoteOld = fakeTransport();
        const remoteNew = fakeTransport();
        const tokens: { forceRefresh: boolean }[] = [];
        let calls = 0;
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async (input) => {
                tokens.push(input);
                return input.forceRefresh ? 'token-2' : 'token-1';
            },
            stdioTransport: () => host,
            remoteTransport: (token) => {
                calls += 1;
                if (calls === 1) {
                    expect(token).toBe('token-1');
                    return remoteOld;
                }
                expect(token).toBe('token-2');
                return remoteNew;
            },
        });
        const running = bridge.run();
        await tick();
        remoteOld.fireError(Object.assign(new Error('unauthorized'), { code: 401 }));
        await tick();
        expect(tokens).toEqual([{ forceRefresh: false }, { forceRefresh: true }]);
        expect(remoteOld.closed).toBe(true);
        host.fireClose();
        await running;
    });

    it('gives up after exhausting maxReauthAttempts', async () => {
        const host = fakeTransport();
        const remote = fakeTransport();
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async () => 'token',
            stdioTransport: () => host,
            remoteTransport: () => remote,
            maxReauthAttempts: 0,
        });
        const running = bridge.run();
        await tick();
        remote.fireError(Object.assign(new Error('unauthorized'), { code: 401 }));
        await running;
        expect(host.closed).toBe(true);
    });
});

describe('error handling', () => {
    it('shuts down on a non-401 transport error', async () => {
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
        remote.fireError(Object.assign(new Error('boom'), { code: 500 }));
        await running;
        expect(host.closed).toBe(true);
        expect(remote.closed).toBe(true);
    });

    it('uses status as a fallback to code', async () => {
        const host = fakeTransport();
        const remoteA = fakeTransport();
        const remoteB = fakeTransport();
        let n = 0;
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async () => 'token',
            stdioTransport: () => host,
            remoteTransport: () => (++n === 1 ? remoteA : remoteB),
        });
        const running = bridge.run();
        await tick();
        remoteA.fireError(Object.assign(new Error('unauthorized'), { status: 401 }));
        await tick();
        expect(remoteA.closed).toBe(true);
        host.fireClose();
        await running;
    });

    it('shuts down when reconnect after 401 fails', async () => {
        const host = fakeTransport();
        const remoteA = fakeTransport();
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async (input) => {
                if (input.forceRefresh) throw new Error('refresh failed');
                return 'token';
            },
            stdioTransport: () => host,
            remoteTransport: () => remoteA,
        });
        const running = bridge.run();
        await tick();
        remoteA.fireError(Object.assign(new Error('unauthorized'), { code: 401 }));
        await running;
        expect(host.closed).toBe(true);
    });

    it('handles errors with no status / code by failing the host', async () => {
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
        remote.fireError(new Error('unknown'));
        await running;
        expect(host.closed).toBe(true);
    });
});

describe('forward errors', () => {
    it('does not crash when remote.send throws', async () => {
        const host = fakeTransport();
        const remote: FakeTransport = {
            ...fakeTransport(),
            async send() {
                throw Object.assign(new Error('connection reset'), { code: 502 });
            },
        };
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async () => 'token',
            stdioTransport: () => host,
            remoteTransport: () => remote,
        });
        const running = bridge.run();
        await tick();
        host.fireMessage(SAMPLE_REQUEST);
        await running;
    });

    it('drops messages from the remote after the host closes', async () => {
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
        host.fireClose();
        await running;
        const late: JSONRPCMessage = { jsonrpc: '2.0', id: 99, result: {} };
        remote.fireMessage(late);
        expect(host.sent).toEqual([]);
    });
});

describe('close handling', () => {
    it('treats unsolicited remote close as a 401-equivalent (reconnect once)', async () => {
        const host = fakeTransport();
        const remoteA = fakeTransport();
        const remoteB = fakeTransport();
        let n = 0;
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async () => 'token',
            stdioTransport: () => host,
            remoteTransport: () => (++n === 1 ? remoteA : remoteB),
        });
        const running = bridge.run();
        await tick();
        remoteA.fireClose();
        await tick();
        expect(remoteB.started).toBe(true);
        host.fireClose();
        await running;
    });

    it('shuts down when an unsolicited close cannot be reconnected', async () => {
        const host = fakeTransport();
        const remoteA = fakeTransport();
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async (input) => {
                if (input.forceRefresh) throw new Error('refresh failed');
                return 'token';
            },
            stdioTransport: () => host,
            remoteTransport: () => remoteA,
        });
        const running = bridge.run();
        await tick();
        remoteA.fireClose();
        await running;
        expect(host.closed).toBe(true);
    });

    it('gives up when the remote closes after the reauth budget is gone', async () => {
        const host = fakeTransport();
        const remote = fakeTransport();
        const bridge = new StdioBridge({
            remoteUrl: 'https://example.com/mcp',
            getAccessToken: async () => 'token',
            stdioTransport: () => host,
            remoteTransport: () => remote,
            maxReauthAttempts: 0,
        });
        const running = bridge.run();
        await tick();
        remote.fireClose();
        await running;
        expect(host.closed).toBe(true);
    });

    it('shuts down when the host closes mid-flight', async () => {
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
        host.fireClose();
        await running;
        expect(remote.closed).toBe(true);
    });
});
