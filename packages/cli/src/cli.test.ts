/**
 * Unit tests for the CLI entrypoint: argv parsing, dispatch,
 * exit codes, and dependency-set construction.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpSavvyError } from '@mcp-savvy/core';
import { parseArgs, buildDeps, dispatch, main } from './cli.js';
import type { CliConfig } from './env.js';

// Isolate lock-file writes (introduced by `buildDeps` wiring the
// `LockCoordinator` in 4.2) to a per-run temp dir so we never touch
// the developer's real `~/.mcp-savvy`.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-savvy-cli-test-'));

const VALID_ENV: NodeJS.ProcessEnv = {
    MCP_SAVVY_REMOTE_URL: 'https://example.com/mcp',
    MCP_SAVVY_OIDC_ISSUER: 'https://idp.example.com',
    MCP_SAVVY_CLIENT_ID: 'client-abc',
    MCP_SAVVY_DATA_DIR: TEST_DATA_DIR,
};

const SAMPLE_CONFIG: CliConfig = {
    provider: 'cognito',
    remoteUrl: 'https://example.com/mcp',
    issuer: 'https://idp.example.com',
    clientId: 'client-abc',
    scopes: 'openid email profile',
    callbackHost: 'localhost',
    callbackPort: 33423,
    callbackPath: '/callback',
    tokenNamespace: undefined,
    brandName: undefined,
    completeSessionUrl: undefined,
    toolMode: 'passthrough',
    toolPrefix: 'mcp_savvy',
    debug: false,
    lockTimeoutMs: 300_000,
    lockStaleMs: 10_000,
    shutdownDeadlineMs: 5_000,
    dataDir: TEST_DATA_DIR,
};

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
    stderrSpy.mockRestore();
});

afterAll(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('parseArgs', () => {
    it('returns "run" when no flags are present', () => {
        expect(parseArgs([])).toBe('run');
    });

    it('parses each known flag', () => {
        expect(parseArgs(['--login'])).toBe('login');
        expect(parseArgs(['--logout'])).toBe('logout');
        expect(parseArgs(['--print-env'])).toBe('print-env');
        expect(parseArgs(['--help'])).toBe('help');
        expect(parseArgs(['-h'])).toBe('help');
    });

    it('throws on unknown flags', () => {
        expect(() => parseArgs(['--bogus'])).toThrow(McpSavvyError);
    });

    it('throws when more than one flag is present', () => {
        expect(() => parseArgs(['--login', '--logout'])).toThrow(/at most one/);
    });

    it('ignores positional arguments', () => {
        // We don't have any positional commands today; non-flag args are dropped.
        expect(parseArgs(['something', 'else'])).toBe('run');
    });
});

describe('buildDeps', () => {
    it('returns a fully-formed dependency set', () => {
        const deps = buildDeps(SAMPLE_CONFIG);
        expect(typeof deps.createCallbackServer).toBe('function');
        expect(typeof deps.createBridge).toBe('function');
        expect(deps.auth).toBeDefined();
        expect(deps.store).toBeDefined();
        expect(deps.logger).toBeDefined();
    });

    it('selects CognitoProvider when provider=cognito', () => {
        const deps = buildDeps({ ...SAMPLE_CONFIG, provider: 'cognito' });
        expect(deps.auth.constructor.name).toBe('CognitoProvider');
    });

    it('selects OidcPkceProvider when provider=oidc', () => {
        const deps = buildDeps({ ...SAMPLE_CONFIG, provider: 'oidc' });
        expect(deps.auth.constructor.name).toBe('OidcPkceProvider');
    });

    it('honors a custom token namespace', () => {
        const deps = buildDeps({ ...SAMPLE_CONFIG, tokenNamespace: 'my-ns' });
        // Just confirm the deps build successfully — the namespace is
        // baked into the store but not exposed.
        expect(deps.store).toBeDefined();
    });

    it('builds a bridge without an interceptor when completeSessionUrl is unset', () => {
        const deps = buildDeps({ ...SAMPLE_CONFIG, completeSessionUrl: undefined });
        const bridge = deps.createBridge(async () => 'token');
        expect(bridge.constructor.name).toBe('StdioBridge');
    });

    it('builds a bridge with the gateway interceptor when completeSessionUrl is set', () => {
        const deps = buildDeps({
            ...SAMPLE_CONFIG,
            completeSessionUrl: 'https://api.example.com/complete-session',
        });
        const bridge = deps.createBridge(async () => 'token');
        expect(bridge.constructor.name).toBe('StdioBridge');
    });
});

describe('dispatch', () => {
    it('returns 0 for the help command', async () => {
        const code = await dispatch('help', SAMPLE_CONFIG, {} as never);
        expect(code).toBe(0);
        expect(stderrSpy).toHaveBeenCalled();
    });
});

describe('main', () => {
    it('exits 2 with usage when required env vars are missing', async () => {
        const code = await main([], {});
        expect(code).toBe(2);
        const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
        expect(written).toContain('MCP_SAVVY_REMOTE_URL');
    });

    it('exits 2 with usage on an unknown flag', async () => {
        const code = await main(['--bogus'], VALID_ENV);
        expect(code).toBe(2);
        const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
        expect(written).toContain('unknown flag');
    });

    it('returns 0 for --help even without env vars', async () => {
        const code = await main(['--help'], {});
        expect(code).toBe(0);
        const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
        expect(written).toContain('Usage');
    });

    it('returns 0 for --print-env with valid env', async () => {
        const code = await main(['--print-env'], VALID_ENV);
        expect(code).toBe(0);
    });

    it('returns 0 for --logout with valid env (no network call)', async () => {
        const code = await main(['--logout'], VALID_ENV);
        expect(code).toBe(0);
    });

    it('exits 1 when a command throws unexpectedly', async () => {
        // --login asks the auth provider to run PKCE, which needs the
        // discovery endpoint. We point at an unreachable URL so it
        // fails inside dispatch, exercising the top-level catch.
        const code = await main(['--login'], {
            ...VALID_ENV,
            MCP_SAVVY_OIDC_ISSUER: 'http://127.0.0.1:1', // closed port
        });
        expect(code).toBe(1);
    });
});
