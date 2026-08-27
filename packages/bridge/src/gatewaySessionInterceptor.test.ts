/**
 * Unit tests for `gatewaySessionInterceptor`. Stubs out
 * `completeGatewaySession` so we can verify the interceptor's
 * decision logic without binding any sockets or opening browsers.
 */

import { describe, it, expect, vi } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { CompleteGatewaySessionInput } from '@mcp-savvy/auth';
import {
    gatewaySessionInterceptor,
    URL_ELICITATION_REQUIRED,
} from './gatewaySessionInterceptor.js';

const TOOLS_CALL_REQUEST: JSONRPCMessage = {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'github___listUserRepos', arguments: {} },
};

const ELICITATION_RESPONSE: JSONRPCMessage = {
    jsonrpc: '2.0',
    id: 7,
    error: {
        code: URL_ELICITATION_REQUIRED,
        message: 'URL elicitation required',
        data: {
            elicitations: [
                {
                    mode: 'url',
                    url: 'https://github.com/login/oauth/authorize?request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Asession-1',
                    elicitationId: 'elic-1',
                    message: 'Authorize GitHub',
                },
            ],
        },
    },
};

const PLAIN_RESULT: JSONRPCMessage = {
    jsonrpc: '2.0',
    id: 7,
    result: { content: [] },
};

function makeInterceptor(
    overrides: {
        completeSession?: (input: CompleteGatewaySessionInput) => Promise<unknown>;
        getUserToken?: () => Promise<string> | string;
    } = {},
) {
    const completeSession =
        overrides.completeSession ??
        vi.fn(async () => ({ sessionUri: 'session-1' }));
    const getUserToken = overrides.getUserToken ?? (async () => 'jwt-1');
    const openBrowser = vi.fn();
    const interceptor = gatewaySessionInterceptor({
        completeSessionEndpoint: 'https://api.example.com/complete-session',
        getUserToken,
        openBrowser,
        completeSession,
    });
    return { interceptor, completeSession, openBrowser };
}

describe('gatewaySessionInterceptor', () => {
    it('forwards plain responses unchanged', async () => {
        const { interceptor, completeSession } = makeInterceptor();
        const action = await interceptor({
            response: PLAIN_RESULT,
            originalRequest: TOOLS_CALL_REQUEST,
        });
        expect(action).toEqual({ kind: 'forward' });
        expect(completeSession).not.toHaveBeenCalled();
    });

    it('completes the session and retries on a URL elicitation', async () => {
        const completeSession = vi.fn(async () => ({ sessionUri: 'session-1' }));
        const { interceptor } = makeInterceptor({ completeSession });
        const action = await interceptor({
            response: ELICITATION_RESPONSE,
            originalRequest: TOOLS_CALL_REQUEST,
        });
        expect(action).toEqual({ kind: 'retry' });
        expect(completeSession).toHaveBeenCalledTimes(1);
        const call = completeSession.mock.calls[0]?.[0] as CompleteGatewaySessionInput;
        expect(call.authorizationUrl).toBe(
            'https://github.com/login/oauth/authorize?request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Asession-1',
        );
        expect(call.completeSessionEndpoint).toBe(
            'https://api.example.com/complete-session',
        );
        expect(call.userToken).toBe('jwt-1');
    });

    it('refreshes the user token by calling getUserToken on every elicitation', async () => {
        let n = 0;
        const completeSession = vi.fn(async () => ({ sessionUri: 'session-x' }));
        const { interceptor } = makeInterceptor({
            completeSession,
            getUserToken: async () => `jwt-${++n}`,
        });
        await interceptor({
            response: ELICITATION_RESPONSE,
            originalRequest: TOOLS_CALL_REQUEST,
        });
        await interceptor({
            response: ELICITATION_RESPONSE,
            originalRequest: TOOLS_CALL_REQUEST,
        });
        const tokens = completeSession.mock.calls.map(
            (c) => (c[0] as CompleteGatewaySessionInput).userToken,
        );
        expect(tokens).toEqual(['jwt-1', 'jwt-2']);
    });

    it('forwards if the original request was not a tools/call', async () => {
        const completeSession = vi.fn(async () => ({ sessionUri: 's' }));
        const { interceptor } = makeInterceptor({ completeSession });
        const initialize: JSONRPCMessage = {
            jsonrpc: '2.0',
            id: 7,
            method: 'initialize',
            params: {},
        };
        const action = await interceptor({
            response: ELICITATION_RESPONSE,
            originalRequest: initialize,
        });
        expect(action).toEqual({ kind: 'forward' });
        expect(completeSession).not.toHaveBeenCalled();
    });

    it('forwards if the elicitation response has no matching original request', async () => {
        const completeSession = vi.fn(async () => ({ sessionUri: 's' }));
        const { interceptor } = makeInterceptor({ completeSession });
        const action = await interceptor({
            response: ELICITATION_RESPONSE,
            originalRequest: undefined,
        });
        expect(action).toEqual({ kind: 'forward' });
        expect(completeSession).not.toHaveBeenCalled();
    });

    it('forwards on completion failure so the host sees the original error', async () => {
        const completeSession = vi.fn(async () => {
            throw new Error('session binding failed');
        });
        const { interceptor } = makeInterceptor({ completeSession });
        const action = await interceptor({
            response: ELICITATION_RESPONSE,
            originalRequest: TOOLS_CALL_REQUEST,
        });
        expect(action).toEqual({ kind: 'forward' });
        expect(completeSession).toHaveBeenCalledTimes(1);
    });

    it('ignores non-URL elicitations (form-mode is host-side only)', async () => {
        const completeSession = vi.fn(async () => ({ sessionUri: 's' }));
        const { interceptor } = makeInterceptor({ completeSession });
        const formMode: JSONRPCMessage = {
            jsonrpc: '2.0',
            id: 7,
            error: {
                code: URL_ELICITATION_REQUIRED,
                message: 'should not match',
                data: {
                    elicitations: [{ mode: 'form', message: 'name?' }],
                },
            },
        };
        const action = await interceptor({
            response: formMode,
            originalRequest: TOOLS_CALL_REQUEST,
        });
        expect(action).toEqual({ kind: 'forward' });
        expect(completeSession).not.toHaveBeenCalled();
    });

    it('ignores error responses with a different code', async () => {
        const completeSession = vi.fn(async () => ({ sessionUri: 's' }));
        const { interceptor } = makeInterceptor({ completeSession });
        const otherError: JSONRPCMessage = {
            jsonrpc: '2.0',
            id: 7,
            error: { code: -32603, message: 'internal error' },
        };
        const action = await interceptor({
            response: otherError,
            originalRequest: TOOLS_CALL_REQUEST,
        });
        expect(action).toEqual({ kind: 'forward' });
        expect(completeSession).not.toHaveBeenCalled();
    });

    it('ignores malformed elicitation payloads', async () => {
        const completeSession = vi.fn(async () => ({ sessionUri: 's' }));
        const { interceptor } = makeInterceptor({ completeSession });
        const malformed: JSONRPCMessage = {
            jsonrpc: '2.0',
            id: 7,
            error: {
                code: URL_ELICITATION_REQUIRED,
                message: 'bad shape',
                data: { elicitations: 'not-an-array' },
            },
        };
        const action = await interceptor({
            response: malformed,
            originalRequest: TOOLS_CALL_REQUEST,
        });
        expect(action).toEqual({ kind: 'forward' });
        expect(completeSession).not.toHaveBeenCalled();
    });
});
