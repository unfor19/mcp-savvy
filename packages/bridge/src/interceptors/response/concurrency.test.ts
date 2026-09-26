/** Concurrency tests for response interception and retry reservation. */

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { StdioBridge } from '../../stdioBridge.js';
import { fakeTransport, SAMPLE_REQUEST, tick } from '../../testFixtures.js';
import type { ResponseAction, ResponseInterceptor } from '../response.js';

const SAMPLE_RESPONSE: JSONRPCMessage = {
    jsonrpc: '2.0',
    id: 1,
    result: { tools: [] },
};

describe('response interceptor concurrency', () => {
    it('drops an overlapping duplicate while completion owns the request', async () => {
        const host = fakeTransport();
        const remote = fakeTransport();
        const retryAvailability: Array<boolean | undefined> = [];
        let finishFirst: ((action: ResponseAction) => void) | undefined;
        const interceptor: ResponseInterceptor = vi.fn(({ retryAvailable }) => {
            retryAvailability.push(retryAvailable);
            if (retryAvailability.length === 1) {
                return new Promise<ResponseAction>((resolve) => {
                    finishFirst = resolve;
                });
            }
            return { kind: 'forward' };
        });
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

        remote.fireMessage(SAMPLE_RESPONSE);
        await tick();
        remote.fireMessage(SAMPLE_RESPONSE);
        await tick();
        expect(interceptor).toHaveBeenCalledTimes(1);
        expect(host.sent).toEqual([]);

        finishFirst?.({ kind: 'retry' });
        await tick();
        expect(remote.sent).toEqual([SAMPLE_REQUEST, SAMPLE_REQUEST]);

        remote.fireMessage(SAMPLE_RESPONSE);
        await tick();
        expect(retryAvailability).toEqual([true, false]);
        expect(host.sent).toEqual([SAMPLE_RESPONSE]);
        host.fireClose();
        await running;
    });
});
