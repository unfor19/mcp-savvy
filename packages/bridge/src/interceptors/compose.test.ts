/**
 * Unit tests for `composeRequestInterceptors` /
 * `composeResponseInterceptors`. Composition policy: first
 * non-`forward` action short-circuits the chain.
 */

import { describe, it, expect } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
    composeRequestInterceptors,
    composeResponseInterceptors,
} from './compose.js';
import type { RequestInterceptor } from './request.js';
import type { ResponseInterceptor } from './response.js';

const REQUEST: JSONRPCMessage = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'foo', arguments: {} },
};

const RESPONSE: JSONRPCMessage = {
    jsonrpc: '2.0',
    id: 1,
    result: {},
};

describe('composeRequestInterceptors', () => {
    it('chains forwards into a final forward', async () => {
        const a: RequestInterceptor = () => ({ kind: 'forward' });
        const b: RequestInterceptor = () => ({ kind: 'forward' });
        const composed = composeRequestInterceptors([a, b]);
        const action = await composed({ request: REQUEST });
        expect(action).toEqual({ kind: 'forward' });
    });

    it('first non-forward wins (replace short-circuits the chain)', async () => {
        const calls: string[] = [];
        const a: RequestInterceptor = () => {
            calls.push('a');
            return { kind: 'replace', message: { ...REQUEST, method: 'rewritten' } };
        };
        const b: RequestInterceptor = () => {
            calls.push('b');
            return { kind: 'forward' };
        };
        const composed = composeRequestInterceptors([a, b]);
        const action = await composed({ request: REQUEST });
        expect(action.kind).toBe('replace');
        expect(calls).toEqual(['a']);
    });

    it('falls through if earlier interceptors forward', async () => {
        const a: RequestInterceptor = () => ({ kind: 'forward' });
        const b: RequestInterceptor = () => ({
            kind: 'swallow',
            respond: { jsonrpc: '2.0', id: 1, result: { fake: true } },
        });
        const composed = composeRequestInterceptors([a, b]);
        const action = await composed({ request: REQUEST });
        expect(action.kind).toBe('swallow');
    });

    it('handles an empty list as forward', async () => {
        const composed = composeRequestInterceptors([]);
        const action = await composed({ request: REQUEST });
        expect(action).toEqual({ kind: 'forward' });
    });
});

describe('composeResponseInterceptors', () => {
    it('chains forwards into a final forward', async () => {
        const a: ResponseInterceptor = () => ({ kind: 'forward' });
        const b: ResponseInterceptor = () => ({ kind: 'forward' });
        const composed = composeResponseInterceptors([a, b]);
        const action = await composed({ response: RESPONSE, originalRequest: undefined });
        expect(action).toEqual({ kind: 'forward' });
    });

    it('first non-forward wins (retry short-circuits the chain)', async () => {
        const calls: string[] = [];
        const a: ResponseInterceptor = () => {
            calls.push('a');
            return { kind: 'retry' };
        };
        const b: ResponseInterceptor = () => {
            calls.push('b');
            return { kind: 'forward' };
        };
        const composed = composeResponseInterceptors([a, b]);
        const action = await composed({ response: RESPONSE, originalRequest: undefined });
        expect(action.kind).toBe('retry');
        expect(calls).toEqual(['a']);
    });

    it('handles an empty list as forward', async () => {
        const composed = composeResponseInterceptors([]);
        const action = await composed({ response: RESPONSE, originalRequest: undefined });
        expect(action).toEqual({ kind: 'forward' });
    });
});
