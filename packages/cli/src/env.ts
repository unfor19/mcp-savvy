/**
 * Load + validate the `MCP_SAVVY_*` environment-variable contract.
 * This is the public API for end users — keep changes in lockstep
 * with the public contract in `.env.example`.
 */

import os from 'node:os';
import path from 'node:path';
import { ConfigError, LockError } from '@mcp-savvy/core';

/** All known environment variables for the CLI. */
export interface CliConfig {
    provider: 'cognito' | 'oidc';
    remoteUrl: string;
    issuer: string;
    clientId: string;
    scopes: string;
    callbackHost: string;
    callbackPort: number;
    callbackPath: string;
    tokenNamespace: string | undefined;
    brandName: string | undefined;
    completeSessionUrl: string | undefined;
    toolMode: 'passthrough' | 'search-local' | 'search-gateway';
    toolPrefix: string;
    debug: boolean;
    /** Max time to wait for a lock acquisition before timing out. */
    lockTimeoutMs: number;
    /** Staleness threshold past which a sibling treats the lock file as abandoned. */
    lockStaleMs: number;
    /** Max time the CLI shutdown path may spend on cleanup before force-exit. */
    shutdownDeadlineMs: number;
    /** Root data directory for lock files and the encrypted-file token-store fallback. */
    dataDir: string;
}

/** Stable public defaults. */
export const DEFAULT_SCOPES = 'openid email profile';
/**
 * Default loopback host the redirect URI advertises. Whatever value
 * we ship here is what end users have to register on their IdP, so
 * we pick `localhost` (the conventional dev hostname). The callback
 * server still binds to `127.0.0.1` unconditionally — `host` only
 * controls the URL we expose.
 */
export const DEFAULT_CALLBACK_HOST = 'localhost';
export const DEFAULT_CALLBACK_PORT = 33423;
export const DEFAULT_CALLBACK_PATH = '/callback';
/** Default tool mode. See FEATURES.md for the contract. */
export const DEFAULT_TOOL_MODE = 'passthrough';
/** Default tool prefix for `search-first` modes. Overridable for whitelabel. */
export const DEFAULT_TOOL_PREFIX_VALUE = 'mcp_savvy';
/** Tool-prefix validation: standard MCP-identifier shape. */
const TOOL_PREFIX_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Loopback hosts the redirect URI is allowed to advertise. */
const ALLOWED_CALLBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** Default lock-acquisition timeout. See `MCP_SAVVY_LOCK_TIMEOUT_MS` (range 1000–600000). */
export const DEFAULT_LOCK_TIMEOUT_MS = 300_000;
/** Min/max accepted values for `MCP_SAVVY_LOCK_TIMEOUT_MS`. */
const LOCK_TIMEOUT_MIN_MS = 1_000;
const LOCK_TIMEOUT_MAX_MS = 600_000;

/** Default lock-staleness threshold. See `MCP_SAVVY_LOCK_STALE_MS` (range 5000–300000). */
export const DEFAULT_LOCK_STALE_MS = 10_000;
/** Min/max accepted values for `MCP_SAVVY_LOCK_STALE_MS`. */
const LOCK_STALE_MIN_MS = 5_000;
const LOCK_STALE_MAX_MS = 300_000;

/** Default shutdown-deadline. See `MCP_SAVVY_SHUTDOWN_DEADLINE_MS` (range 100–30000). */
export const DEFAULT_SHUTDOWN_DEADLINE_MS = 5_000;
/** Min accepted value for `MCP_SAVVY_SHUTDOWN_DEADLINE_MS`. */
export const SHUTDOWN_DEADLINE_MIN_MS = 100;
/** Max accepted value for `MCP_SAVVY_SHUTDOWN_DEADLINE_MS`. */
export const SHUTDOWN_DEADLINE_MAX_MS = 30_000;

/**
 * Lock heartbeat interval. Fixed at 2000 ms (mid-range of the
 * 1000–30000 ms band allowed by Requirement 2.1). Exposed only so
 * the ratio check below — staleness ≥ 3 × heartbeat — is auditable.
 * No `MCP_SAVVY_LOCK_HEARTBEAT_MS` env var: changing the heartbeat
 * without simultaneously changing the staleness threshold is unsafe.
 */
export const LOCK_HEARTBEAT_MS = 2_000;

/**
 * Read the CLI configuration from a process environment.
 *
 * Throws `ConfigError` listing every missing required variable.
 * Returns a fully-populated `CliConfig` otherwise.
 */
export function loadConfig(env: NodeJS.ProcessEnv): CliConfig {
    const missing: string[] = [];
    const required = (key: string): string => {
        const value = env[key];
        if (!value || value.trim().length === 0) {
            missing.push(key);
            return '';
        }
        return value.trim();
    };

    const providerRaw = (env['MCP_SAVVY_PROVIDER'] ?? 'cognito').trim();
    if (providerRaw !== 'cognito' && providerRaw !== 'oidc') {
        throw new ConfigError(
            `MCP_SAVVY_PROVIDER must be 'cognito' or 'oidc', got '${providerRaw}'`,
        );
    }

    const remoteUrl = required('MCP_SAVVY_REMOTE_URL');
    const issuer = required('MCP_SAVVY_OIDC_ISSUER');
    const clientId = required('MCP_SAVVY_CLIENT_ID');

    if (missing.length > 0) {
        throw new ConfigError(
            `missing required env vars: ${missing.join(', ')}`,
            'CONFIG_MISSING',
        );
    }

    const port = parsePort(env['MCP_SAVVY_CALLBACK_PORT']);
    const host = parseHost(env['MCP_SAVVY_CALLBACK_HOST']);
    const toolMode = parseToolMode(env['MCP_SAVVY_TOOL_MODE']);
    const toolPrefix = parseToolPrefix(env['MCP_SAVVY_TOOL_PREFIX']);
    const lockTimeoutMs = parseLockTimeout(env['MCP_SAVVY_LOCK_TIMEOUT_MS']);
    const lockStaleMs = parseLockStaleness(env['MCP_SAVVY_LOCK_STALE_MS']);
    const shutdownDeadlineMs = parseShutdownDeadline(env['MCP_SAVVY_SHUTDOWN_DEADLINE_MS']);
    const dataDir = parseDataDir(env['MCP_SAVVY_DATA_DIR']);

    // Defense-in-depth: enforce staleness ≥ 3× heartbeat (Req 2.3). Given
    // the heartbeat is fixed at 2000 ms and the staleness range minimum is
    // 5000 ms, every in-range input already passes — but a future tweak to
    // the constants could regress this without the runtime guard.
    if (lockStaleMs < 3 * LOCK_HEARTBEAT_MS) {
        throw new LockError(
            'LOCK_CONFIG_INVALID',
            `staleness threshold ${lockStaleMs}ms must be at least 3x heartbeat interval ${LOCK_HEARTBEAT_MS}ms`,
        );
    }

    return {
        provider: providerRaw,
        remoteUrl,
        issuer,
        clientId,
        scopes: env['MCP_SAVVY_SCOPES']?.trim() || DEFAULT_SCOPES,
        callbackHost: host,
        callbackPort: port,
        callbackPath: env['MCP_SAVVY_CALLBACK_PATH']?.trim() || DEFAULT_CALLBACK_PATH,
        tokenNamespace: env['MCP_SAVVY_TOKEN_NAMESPACE']?.trim() || undefined,
        brandName: env['MCP_SAVVY_BRAND_NAME']?.trim() || undefined,
        completeSessionUrl: env['MCP_SAVVY_COMPLETE_SESSION_URL']?.trim() || undefined,
        toolMode,
        toolPrefix,
        debug: env['MCP_SAVVY_DEBUG'] === '1',
        lockTimeoutMs,
        lockStaleMs,
        shutdownDeadlineMs,
        dataDir,
    };
}

/** Parse the callback port; reject anything outside the unprivileged range. */
function parsePort(raw: string | undefined): number {
    if (!raw || raw.trim().length === 0) return DEFAULT_CALLBACK_PORT;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1024 || n > 65535) {
        throw new ConfigError(
            `MCP_SAVVY_CALLBACK_PORT must be an integer in [1024, 65535], got '${raw}'`,
        );
    }
    return n;
}

/**
 * Parse the callback host. Accepts only loopback names (`localhost`
 * or `127.0.0.1`) — both resolve to the loopback interface, so this
 * doesn't widen the security posture. `localhost` is the project's
 * convention; the override exists for environments where the IdP's
 * registered redirect URI uses the literal IP form.
 */
function parseHost(raw: string | undefined): string {
    const trimmed = raw?.trim();
    if (!trimmed) return DEFAULT_CALLBACK_HOST;
    if (!ALLOWED_CALLBACK_HOSTS.has(trimmed)) {
        throw new ConfigError(
            `MCP_SAVVY_CALLBACK_HOST must be 'localhost' or '127.0.0.1', got '${trimmed}'`,
        );
    }
    return trimmed;
}

/**
 * Parse `MCP_SAVVY_TOOL_MODE`. Three values, default `passthrough`.
 * See FEATURES.md for the contract.
 */
function parseToolMode(
    raw: string | undefined,
): 'passthrough' | 'search-local' | 'search-gateway' {
    const trimmed = raw?.trim();
    if (!trimmed) return DEFAULT_TOOL_MODE;
    if (
        trimmed !== 'passthrough' &&
        trimmed !== 'search-local' &&
        trimmed !== 'search-gateway'
    ) {
        throw new ConfigError(
            `MCP_SAVVY_TOOL_MODE must be 'passthrough', 'search-local', or 'search-gateway', got '${trimmed}'`,
        );
    }
    return trimmed;
}

/**
 * Parse `MCP_SAVVY_TOOL_PREFIX`. Must be a valid MCP-identifier
 * shape (`^[a-z][a-z0-9_]*$`) so the synthesized tool names stay
 * legal across hosts. Defaults to `mcp_savvy`.
 */
function parseToolPrefix(raw: string | undefined): string {
    const trimmed = raw?.trim();
    if (!trimmed) return DEFAULT_TOOL_PREFIX_VALUE;
    if (!TOOL_PREFIX_PATTERN.test(trimmed)) {
        throw new ConfigError(
            `MCP_SAVVY_TOOL_PREFIX must match ^[a-z][a-z0-9_]*$, got '${trimmed}'`,
        );
    }
    return trimmed;
}

/** Parse `MCP_SAVVY_LOCK_TIMEOUT_MS`; range 1000–600000, default 300000. */
function parseLockTimeout(raw: string | undefined): number {
    return parseRangedInt(
        raw,
        'MCP_SAVVY_LOCK_TIMEOUT_MS',
        LOCK_TIMEOUT_MIN_MS,
        LOCK_TIMEOUT_MAX_MS,
        DEFAULT_LOCK_TIMEOUT_MS,
    );
}

/** Parse `MCP_SAVVY_LOCK_STALE_MS`; range 5000–300000, default 10000. */
function parseLockStaleness(raw: string | undefined): number {
    return parseRangedInt(
        raw,
        'MCP_SAVVY_LOCK_STALE_MS',
        LOCK_STALE_MIN_MS,
        LOCK_STALE_MAX_MS,
        DEFAULT_LOCK_STALE_MS,
    );
}

/** Parse `MCP_SAVVY_SHUTDOWN_DEADLINE_MS`; range 100–30000, default 5000. */
function parseShutdownDeadline(raw: string | undefined): number {
    return parseRangedInt(
        raw,
        'MCP_SAVVY_SHUTDOWN_DEADLINE_MS',
        SHUTDOWN_DEADLINE_MIN_MS,
        SHUTDOWN_DEADLINE_MAX_MS,
        DEFAULT_SHUTDOWN_DEADLINE_MS,
    );
}

/** Parse `MCP_SAVVY_DATA_DIR`; defaults to `<homedir>/.mcp-savvy`. */
function parseDataDir(raw: string | undefined): string {
    const trimmed = raw?.trim();
    if (trimmed && trimmed.length > 0) return trimmed;
    return path.join(os.homedir(), '.mcp-savvy');
}

/**
 * Shared integer-range parser for the lock/shutdown env vars. Throws
 * `ConfigError('CONFIG_INVALID')` on missing-but-malformed, non-numeric,
 * or out-of-range values so the existing `main` error path returns
 * exit code 2.
 */
function parseRangedInt(
    raw: string | undefined,
    name: string,
    min: number,
    max: number,
    fallback: number,
): number {
    if (raw === undefined) return fallback;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return fallback;
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(n) || String(n) !== trimmed || n < min || n > max) {
        throw new ConfigError(
            `${name} must be an integer in [${min}, ${max}], got '${raw}'`,
        );
    }
    return n;
}
