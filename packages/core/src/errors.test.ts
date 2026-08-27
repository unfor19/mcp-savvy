/**
 * Unit tests for the typed error hierarchy.
 */

import { describe, it, expect } from 'vitest';
import {
    McpSavvyError,
    ConfigError,
    AuthError,
    TokenStoreError,
} from './errors.js';

describe('McpSavvyError', () => {
    it('carries code, message, and optional cause', () => {
        const cause = new Error('underlying');
        const err = new McpSavvyError('UNKNOWN', 'top', cause);
        expect(err.code).toBe('UNKNOWN');
        expect(err.message).toBe('top');
        expect(err.cause).toBe(cause);
        expect(err.name).toBe('McpSavvyError');
    });

    it('is an instance of Error', () => {
        const err = new McpSavvyError('UNKNOWN', 'msg');
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(McpSavvyError);
    });

    it('omits cause when not provided', () => {
        const err = new McpSavvyError('UNKNOWN', 'msg');
        expect(err.cause).toBeUndefined();
    });
});

describe('ConfigError', () => {
    it('defaults to CONFIG_INVALID', () => {
        const err = new ConfigError('bad config');
        expect(err.code).toBe('CONFIG_INVALID');
        expect(err.name).toBe('ConfigError');
        expect(err).toBeInstanceOf(McpSavvyError);
    });

    it('accepts CONFIG_MISSING', () => {
        const err = new ConfigError('missing', 'CONFIG_MISSING');
        expect(err.code).toBe('CONFIG_MISSING');
    });
});

describe('AuthError', () => {
    it('preserves the chosen code and cause', () => {
        const cause = new Error('upstream');
        const err = new AuthError('AUTH_TIMEOUT', 'login took too long', cause);
        expect(err.code).toBe('AUTH_TIMEOUT');
        expect(err.cause).toBe(cause);
        expect(err.name).toBe('AuthError');
    });
});

describe('TokenStoreError', () => {
    it('only accepts read/write codes (compile time) and round-trips them', () => {
        const r = new TokenStoreError('TOKEN_STORE_READ_FAILED', 'cannot read');
        const w = new TokenStoreError('TOKEN_STORE_WRITE_FAILED', 'cannot write');
        expect(r.code).toBe('TOKEN_STORE_READ_FAILED');
        expect(w.code).toBe('TOKEN_STORE_WRITE_FAILED');
        expect(r.name).toBe('TokenStoreError');
    });
});
