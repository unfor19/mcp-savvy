/** Security regression tests for the public MCP error boundary. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatch } from '../mcp.mjs';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('dispatch', () => {
    it('does not expose thrown implementation details to the caller or log', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const canary = 'private-upstream-canary';
        const params = {};
        Object.defineProperty(params, 'uri', {
            get() {
                throw new Error(canary);
            },
        });

        const response = await dispatch(
            { jsonrpc: '2.0', id: 1, method: 'resources/read', params },
            {},
        );

        expect(response).toEqual({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32603, message: 'Internal error' },
        });
        expect(JSON.stringify(logged.mock.calls)).not.toContain(canary);
    });
});
