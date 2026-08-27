/**
 * Unit tests for the env-var loader.
 */

import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ConfigError } from '@mcp-savvy/core';
import {
    loadConfig,
    DEFAULT_SCOPES,
    DEFAULT_CALLBACK_HOST,
    DEFAULT_CALLBACK_PORT,
    DEFAULT_CALLBACK_PATH,
    DEFAULT_LOCK_TIMEOUT_MS,
    DEFAULT_LOCK_STALE_MS,
    DEFAULT_SHUTDOWN_DEADLINE_MS,
} from './env.js';

const REQUIRED: NodeJS.ProcessEnv = {
    MCP_SAVVY_REMOTE_URL: 'https://example.com/mcp',
    MCP_SAVVY_OIDC_ISSUER: 'https://idp.example.com',
    MCP_SAVVY_CLIENT_ID: 'client-abc',
};

/** Assert loadConfig throws a `ConfigError('CONFIG_INVALID')` naming `envVar`. */
function expectConfigError(env: NodeJS.ProcessEnv, envVar: string): void {
    let caught: unknown;
    try {
        loadConfig(env);
    } catch (err) {
        caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const cfgErr = caught as ConfigError;
    expect(cfgErr.code).toBe('CONFIG_INVALID');
    expect(cfgErr.message).toContain(envVar);
}

describe('loadConfig', () => {
    it('loads required vars and applies defaults', () => {
        const cfg = loadConfig(REQUIRED);
        expect(cfg.provider).toBe('cognito');
        expect(cfg.remoteUrl).toBe('https://example.com/mcp');
        expect(cfg.issuer).toBe('https://idp.example.com');
        expect(cfg.clientId).toBe('client-abc');
        expect(cfg.scopes).toBe(DEFAULT_SCOPES);
        expect(cfg.callbackHost).toBe(DEFAULT_CALLBACK_HOST);
        expect(cfg.callbackPort).toBe(DEFAULT_CALLBACK_PORT);
        expect(cfg.callbackPath).toBe(DEFAULT_CALLBACK_PATH);
        expect(cfg.tokenNamespace).toBeUndefined();
        expect(cfg.brandName).toBeUndefined();
        expect(cfg.debug).toBe(false);
    });

    it('throws ConfigError listing every missing required var', () => {
        try {
            loadConfig({});
            expect.fail('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(ConfigError);
            const msg = (err as Error).message;
            expect(msg).toContain('MCP_SAVVY_REMOTE_URL');
            expect(msg).toContain('MCP_SAVVY_OIDC_ISSUER');
            expect(msg).toContain('MCP_SAVVY_CLIENT_ID');
        }
    });

    it('treats whitespace-only values as missing', () => {
        const env = { ...REQUIRED, MCP_SAVVY_REMOTE_URL: '   ' };
        expect(() => loadConfig(env)).toThrow(/MCP_SAVVY_REMOTE_URL/);
    });

    it('rejects an unknown provider', () => {
        const env = { ...REQUIRED, MCP_SAVVY_PROVIDER: 'twitter' };
        expect(() => loadConfig(env)).toThrow(/cognito.*oidc/);
    });

    it('accepts provider=oidc', () => {
        expect(loadConfig({ ...REQUIRED, MCP_SAVVY_PROVIDER: 'oidc' }).provider).toBe('oidc');
    });

    it('honors custom scopes', () => {
        expect(loadConfig({ ...REQUIRED, MCP_SAVVY_SCOPES: 'openid email' }).scopes).toBe(
            'openid email',
        );
    });

    it('parses a valid callback port', () => {
        expect(loadConfig({ ...REQUIRED, MCP_SAVVY_CALLBACK_PORT: '40000' }).callbackPort).toBe(
            40000,
        );
    });

    it('rejects a callback port outside the allowed range', () => {
        expect(() => loadConfig({ ...REQUIRED, MCP_SAVVY_CALLBACK_PORT: '80' })).toThrow(
            /CALLBACK_PORT/,
        );
        expect(() => loadConfig({ ...REQUIRED, MCP_SAVVY_CALLBACK_PORT: '70000' })).toThrow(
            /CALLBACK_PORT/,
        );
        expect(() => loadConfig({ ...REQUIRED, MCP_SAVVY_CALLBACK_PORT: 'abc' })).toThrow(
            /CALLBACK_PORT/,
        );
    });

    it('honors a custom callback path', () => {
        expect(
            loadConfig({ ...REQUIRED, MCP_SAVVY_CALLBACK_PATH: '/oauth/callback' }).callbackPath,
        ).toBe('/oauth/callback');
    });

    it('honors MCP_SAVVY_CALLBACK_HOST=127.0.0.1', () => {
        expect(
            loadConfig({ ...REQUIRED, MCP_SAVVY_CALLBACK_HOST: '127.0.0.1' }).callbackHost,
        ).toBe('127.0.0.1');
    });

    it('rejects non-loopback callback hosts', () => {
        expect(() => loadConfig({ ...REQUIRED, MCP_SAVVY_CALLBACK_HOST: '0.0.0.0' })).toThrow(
            /CALLBACK_HOST/,
        );
        expect(() => loadConfig({ ...REQUIRED, MCP_SAVVY_CALLBACK_HOST: 'example.com' })).toThrow(
            /CALLBACK_HOST/,
        );
    });

    it('passes through token namespace and brand name', () => {
        const cfg = loadConfig({
            ...REQUIRED,
            MCP_SAVVY_TOKEN_NAMESPACE: 'my-ns',
            MCP_SAVVY_BRAND_NAME: 'ACME',
        });
        expect(cfg.tokenNamespace).toBe('my-ns');
        expect(cfg.brandName).toBe('ACME');
    });

    it('passes through MCP_SAVVY_COMPLETE_SESSION_URL', () => {
        const cfg = loadConfig({
            ...REQUIRED,
            MCP_SAVVY_COMPLETE_SESSION_URL: 'https://api.example.com/complete-session',
        });
        expect(cfg.completeSessionUrl).toBe('https://api.example.com/complete-session');
    });

    it('completeSessionUrl is undefined by default', () => {
        expect(loadConfig(REQUIRED).completeSessionUrl).toBeUndefined();
    });

    it('toolMode defaults to passthrough', () => {
        expect(loadConfig(REQUIRED).toolMode).toBe('passthrough');
    });

    it('toolMode honors search-local and search-gateway', () => {
        expect(loadConfig({ ...REQUIRED, MCP_SAVVY_TOOL_MODE: 'search-local' }).toolMode).toBe(
            'search-local',
        );
        expect(loadConfig({ ...REQUIRED, MCP_SAVVY_TOOL_MODE: 'search-gateway' }).toolMode).toBe(
            'search-gateway',
        );
    });

    it('rejects an unknown toolMode', () => {
        expect(() => loadConfig({ ...REQUIRED, MCP_SAVVY_TOOL_MODE: 'whatever' })).toThrow(
            /MCP_SAVVY_TOOL_MODE/,
        );
    });

    it('toolPrefix defaults to mcp_savvy', () => {
        expect(loadConfig(REQUIRED).toolPrefix).toBe('mcp_savvy');
    });

    it('toolPrefix accepts whitelabel overrides matching the identifier shape', () => {
        expect(loadConfig({ ...REQUIRED, MCP_SAVVY_TOOL_PREFIX: 'acme' }).toolPrefix).toBe('acme');
        expect(
            loadConfig({ ...REQUIRED, MCP_SAVVY_TOOL_PREFIX: 'globex_corp' }).toolPrefix,
        ).toBe('globex_corp');
    });

    it('rejects toolPrefix that violates the identifier shape', () => {
        expect(() => loadConfig({ ...REQUIRED, MCP_SAVVY_TOOL_PREFIX: 'Acme' })).toThrow(
            /MCP_SAVVY_TOOL_PREFIX/,
        );
        expect(() => loadConfig({ ...REQUIRED, MCP_SAVVY_TOOL_PREFIX: '1acme' })).toThrow(
            /MCP_SAVVY_TOOL_PREFIX/,
        );
        expect(() => loadConfig({ ...REQUIRED, MCP_SAVVY_TOOL_PREFIX: 'acme corp' })).toThrow(
            /MCP_SAVVY_TOOL_PREFIX/,
        );
    });

    it('treats MCP_SAVVY_DEBUG=1 as true', () => {
        expect(loadConfig({ ...REQUIRED, MCP_SAVVY_DEBUG: '1' }).debug).toBe(true);
        expect(loadConfig({ ...REQUIRED, MCP_SAVVY_DEBUG: 'true' }).debug).toBe(false);
        expect(loadConfig({ ...REQUIRED, MCP_SAVVY_DEBUG: '0' }).debug).toBe(false);
    });
});

interface RangedIntCase {
    envVar: string;
    min: number;
    max: number;
    defaultValue: number;
    inRange: number;
    cfgKey: 'lockTimeoutMs' | 'lockStaleMs' | 'shutdownDeadlineMs';
}

const RANGED_INT_CASES: RangedIntCase[] = [
    {
        envVar: 'MCP_SAVVY_LOCK_TIMEOUT_MS',
        min: 1000,
        max: 600000,
        defaultValue: DEFAULT_LOCK_TIMEOUT_MS,
        inRange: 60000,
        cfgKey: 'lockTimeoutMs',
    },
    {
        envVar: 'MCP_SAVVY_LOCK_STALE_MS',
        min: 5000,
        max: 300000,
        defaultValue: DEFAULT_LOCK_STALE_MS,
        inRange: 30000,
        cfgKey: 'lockStaleMs',
    },
    {
        envVar: 'MCP_SAVVY_SHUTDOWN_DEADLINE_MS',
        min: 100,
        max: 30000,
        defaultValue: DEFAULT_SHUTDOWN_DEADLINE_MS,
        inRange: 10000,
        cfgKey: 'shutdownDeadlineMs',
    },
];

describe.each(RANGED_INT_CASES)('$envVar (range $min–$max)', (c) => {
    it('uses the default when the value is empty', () => {
        expect(loadConfig({ ...REQUIRED, [c.envVar]: '' })[c.cfgKey]).toBe(c.defaultValue);
    });

    it('parses an in-range value', () => {
        expect(loadConfig({ ...REQUIRED, [c.envVar]: String(c.inRange) })[c.cfgKey]).toBe(
            c.inRange,
        );
    });

    it('rejects lower bound minus one', () => {
        expectConfigError({ ...REQUIRED, [c.envVar]: String(c.min - 1) }, c.envVar);
    });

    it('rejects upper bound plus one', () => {
        expectConfigError({ ...REQUIRED, [c.envVar]: String(c.max + 1) }, c.envVar);
    });

    it('rejects non-numeric input', () => {
        expectConfigError({ ...REQUIRED, [c.envVar]: 'abc' }, c.envVar);
    });
});

describe('MCP_SAVVY_DATA_DIR', () => {
    it('defaults to <homedir>/.mcp-savvy when unset', () => {
        expect(loadConfig(REQUIRED).dataDir).toBe(path.join(os.homedir(), '.mcp-savvy'));
    });

    it('defaults to <homedir>/.mcp-savvy when empty', () => {
        expect(loadConfig({ ...REQUIRED, MCP_SAVVY_DATA_DIR: '' }).dataDir).toBe(
            path.join(os.homedir(), '.mcp-savvy'),
        );
    });

    it('honors a custom path', () => {
        expect(loadConfig({ ...REQUIRED, MCP_SAVVY_DATA_DIR: '/tmp/mcp-savvy' }).dataDir).toBe(
            '/tmp/mcp-savvy',
        );
    });
});
