/** Unit tests for authenticated bearer-token extraction. */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
    BedrockAgentCoreClient: class {
        send = send;
    },
    CompleteResourceTokenAuthCommand: class {
        constructor(readonly input: unknown) {}
    },
}));

import { bearerToken, handler } from './index.js';

const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({});
    info.mockClear();
    error.mockClear();
});

afterAll(() => {
    info.mockRestore();
    error.mockRestore();
});

describe('bearerToken', () => {
    it.each([
        [{ Authorization: 'Bearer authenticated-token' }, 'authenticated-token'],
        [{ authorization: 'bearer authenticated-token' }, 'authenticated-token'],
    ])('uses the case-insensitive authenticated header', (headers, expected) => {
        expect(bearerToken(headers)).toBe(expected);
    });

    it.each([undefined, {}, { authorization: 'Basic value' }, { authorization: 'Bearer   ' }])(
        'rejects missing and malformed credentials',
        (headers) => expect(bearerToken(headers)).toBeNull(),
    );
});

describe('handler', () => {
    it('ignores a body-selected token and uses the authenticated header', async () => {
        const sessionUri = 'session-sensitive-value';
        const subject = 'subject-sensitive-value';
        const result = await handler({
            headers: { Authorization: 'Bearer authenticated-token' },
            body: JSON.stringify({ sessionUri, userToken: 'attacker-token' }),
            requestContext: { requestId: 'request-1', authorizer: { sub: subject } },
        });
        expect(result.statusCode).toBe(200);
        expect(send).toHaveBeenCalledOnce();
        expect(send.mock.calls[0]?.[0].input).toEqual({
            sessionUri,
            userIdentifier: { userToken: 'authenticated-token' },
        });
        const audit = String(info.mock.calls[0]?.[0]);
        expect(JSON.parse(audit)).toMatchObject({
            event: 'complete_session',
            outcome: 'success',
            requestId: 'request-1',
        });
        expect(audit).not.toContain(sessionUri);
        expect(audit).not.toContain(subject);
        expect(audit).not.toContain('authenticated-token');
        expect(audit).not.toContain('attacker-token');
    });

    it('fails closed before AgentCore when the bearer header is absent', async () => {
        const result = await handler({ body: JSON.stringify({ sessionUri: 'session-1' }) });
        expect(result.statusCode).toBe(401);
        expect(send).not.toHaveBeenCalled();
        expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({
            event: 'complete_session',
            outcome: 'missing_user_token',
        });
    });

    it('audits malformed input without recording request content', async () => {
        const raw = '{malformed-sensitive-content';
        const result = await handler({ body: raw });
        expect(result.statusCode).toBe(400);
        const audit = String(info.mock.calls[0]?.[0]);
        expect(JSON.parse(audit)).toMatchObject({ outcome: 'invalid_body' });
        expect(audit).not.toContain(raw);
    });

    it('audits AgentCore denials without recording the upstream message', async () => {
        const denial = new Error('upstream-sensitive-message');
        denial.name = 'AccessDeniedException';
        send.mockRejectedValueOnce(denial);
        const result = await handler({
            headers: { Authorization: 'Bearer authenticated-token' },
            body: JSON.stringify({ sessionUri: 'session-sensitive-value' }),
        });
        expect(result.statusCode).toBe(403);
        const audit = String(error.mock.calls[0]?.[0]);
        expect(JSON.parse(audit)).toMatchObject({
            outcome: 'service_error',
            errorType: 'AccessDeniedException',
        });
        expect(audit).not.toContain('upstream-sensitive-message');
        expect(audit).not.toContain('session-sensitive-value');
        expect(result.body).not.toContain('upstream-sensitive-message');
        expect(JSON.parse(result.body)).toEqual({
            error: 'request_rejected',
            message: 'The request was rejected.',
        });
    });
});
