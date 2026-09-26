/** Runtime authorization-result tests for `gatewaySessionInterceptor`. */

import type { CompleteGatewaySessionInput } from '@mcp-savvy/auth';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { gatewaySessionInterceptor } from '../gatewaySessionInterceptor.js';

const TOOLS_CALL_REQUEST: JSONRPCMessage = {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'find_sap_services', arguments: {} },
};

const RUNTIME_AUTHORIZATION_RESPONSE: JSONRPCMessage = {
    jsonrpc: '2.0',
    id: 7,
    result: {
        structuredContent: {
            result: {
                success: false,
                message: 'Authentication required. Please authenticate using the provided URL.',
                data: {
                    error_type: 'authentication_required',
                    requires_user_action: true,
                    auth_url:
                        'https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/authorize?request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Asap-session-1',
                },
            },
        },
    },
};

/** Build an interceptor with a stubbed completion function. */
function makeRuntimeInterceptor(
    completeSession: (input: CompleteGatewaySessionInput) => Promise<unknown>,
) {
    return gatewaySessionInterceptor({
        completeSessionEndpoint: 'https://api.example.com/complete-session',
        getUserToken: async () => 'jwt-1',
        openBrowser: vi.fn(),
        completeSession,
    });
}

describe('gatewaySessionInterceptor Runtime authorization', () => {
    it('completes the session and retries on a Runtime authorization result', async () => {
        const completeSession = vi.fn(async () => ({ sessionUri: 'sap-session-1' }));
        const interceptor = makeRuntimeInterceptor(completeSession);
        const action = await interceptor({
            response: RUNTIME_AUTHORIZATION_RESPONSE,
            originalRequest: TOOLS_CALL_REQUEST,
        });
        expect(action).toEqual({ kind: 'retry' });
        expect(completeSession).toHaveBeenCalledTimes(1);
        const call = completeSession.mock.calls[0]?.[0] as CompleteGatewaySessionInput;
        expect(call.authorizationUrl).toBe(
            'https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/authorize?request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Asap-session-1',
        );
        expect(call.completeSessionEndpoint).toBe(
            'https://api.example.com/complete-session',
        );
        expect(call.userToken).toBe('jwt-1');
    });

    it('does not repeat authorization after the retry budget is exhausted', async () => {
        const completeSession = vi.fn(async () => ({ sessionUri: 'sap-session-1' }));
        const interceptor = makeRuntimeInterceptor(completeSession);
        const action = await interceptor({
            response: RUNTIME_AUTHORIZATION_RESPONSE,
            originalRequest: TOOLS_CALL_REQUEST,
            retryAvailable: false,
        });
        expect(action).toEqual({ kind: 'forward' });
        expect(completeSession).not.toHaveBeenCalled();
    });
});
