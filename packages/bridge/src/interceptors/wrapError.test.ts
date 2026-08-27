/**
 * Tests for `asInterceptorFailure` — the boundary that converts
 * raw interceptor throws into typed `BRIDGE_INTERCEPTOR_FAILURE`
 * errors while leaving already-typed `McpSavvyError` instances
 * alone (so `AuthError` keeps its own category in
 * `categorizeBridgeError`).
 */

import { describe, expect, it } from 'vitest';
import { AuthError, McpSavvyError } from '@mcp-savvy/core';
import { asInterceptorFailure } from './wrapError.js';

describe('asInterceptorFailure', () => {
    it('wraps a generic Error as BRIDGE_INTERCEPTOR_FAILURE', () => {
        const original = new Error('boom');
        const wrapped = asInterceptorFailure(original);
        expect(wrapped).toBeInstanceOf(McpSavvyError);
        const e = wrapped as McpSavvyError;
        expect(e.code).toBe('BRIDGE_INTERCEPTOR_FAILURE');
        expect(e.message).toBe('boom');
        expect(e.cause).toBe(original);
    });

    it('wraps a non-Error throw value using String() for the message', () => {
        const wrapped = asInterceptorFailure('not an error');
        expect(wrapped).toBeInstanceOf(McpSavvyError);
        const e = wrapped as McpSavvyError;
        expect(e.code).toBe('BRIDGE_INTERCEPTOR_FAILURE');
        expect(e.message).toBe('not an error');
        expect(e.cause).toBe('not an error');
    });

    it('passes AuthError through unchanged (keeps BRIDGE_AUTH_FAILURE category)', () => {
        const auth = new AuthError('AUTH_TIMEOUT', 'login timed out');
        const wrapped = asInterceptorFailure(auth);
        expect(wrapped).toBe(auth);
    });

    it('passes any McpSavvyError through unchanged', () => {
        const existing = new McpSavvyError('UNAUTHORIZED', '401 from remote');
        const wrapped = asInterceptorFailure(existing);
        expect(wrapped).toBe(existing);
    });
});
