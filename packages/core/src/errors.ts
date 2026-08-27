/**
 * Typed error hierarchy for mcp-savvy.
 *
 * All errors carry a stable `code` so callers (especially the CLI's
 * top-level error handler) can produce friendly messages without
 * string-matching.
 */

/** Stable error codes for typed handling at boundaries. */
export type McpSavvyErrorCode =
    | 'CONFIG_INVALID'
    | 'CONFIG_MISSING'
    | 'OIDC_DISCOVERY_FAILED'
    | 'AUTH_TIMEOUT'
    | 'AUTH_STATE_MISMATCH'
    | 'AUTH_PROVIDER_ERROR'
    | 'TOKEN_EXCHANGE_FAILED'
    | 'TOKEN_REFRESH_FAILED'
    | 'TOKEN_STORE_READ_FAILED'
    | 'TOKEN_STORE_WRITE_FAILED'
    | 'CALLBACK_PORT_BUSY'
    | 'BRIDGE_TRANSPORT_ERROR'
    | 'UNAUTHORIZED'
    | 'UNKNOWN'
    /** Lock acquisition exceeded the configured `timeoutMs`. */
    | 'LOCK_ACQUISITION_TIMEOUT'
    /** Periodic heartbeat update on a held lock failed. */
    | 'LOCK_HEARTBEAT_FAILED'
    /** Lock-file directory is missing or not writable by the current user. */
    | 'LOCK_DIRECTORY_UNAVAILABLE'
    /** Lock coordinator was constructed with an invalid configuration (e.g. staleness < 3× heartbeat). */
    | 'LOCK_CONFIG_INVALID'
    /** Sibling contention exceeded the platform-level contention wait. */
    | 'LOCK_CONTENTION_TIMEOUT'
    /** Bridge shutdown triggered by an authentication failure against the remote MCP. */
    | 'BRIDGE_AUTH_FAILURE'
    /** Bridge shutdown triggered by an unhandled interceptor failure. */
    | 'BRIDGE_INTERCEPTOR_FAILURE';

/** Base error class for all mcp-savvy failures. */
export class McpSavvyError extends Error {
    override readonly name: string = 'McpSavvyError';
    readonly code: McpSavvyErrorCode;
    override readonly cause?: unknown;

    constructor(code: McpSavvyErrorCode, message: string, cause?: unknown) {
        super(message);
        this.code = code;
        this.cause = cause;
    }
}

/** Configuration is missing or invalid (e.g. required env var unset). */
export class ConfigError extends McpSavvyError {
    override readonly name: string = 'ConfigError';
    constructor(message: string, code: 'CONFIG_INVALID' | 'CONFIG_MISSING' = 'CONFIG_INVALID') {
        super(code, message);
    }
}

/** OIDC/PKCE flow failure (state mismatch, timeout, token exchange). */
export class AuthError extends McpSavvyError {
    override readonly name: string = 'AuthError';
    constructor(code: McpSavvyErrorCode, message: string, cause?: unknown) {
        super(code, message, cause);
    }
}

/** Keychain or encrypted-file token store read/write failure. */
export class TokenStoreError extends McpSavvyError {
    override readonly name: string = 'TokenStoreError';
    constructor(
        code: 'TOKEN_STORE_READ_FAILED' | 'TOKEN_STORE_WRITE_FAILED',
        message: string,
        cause?: unknown,
    ) {
        super(code, message, cause);
    }
}

/** Lock-coordination failure (acquisition timeout, heartbeat, directory, or config). */
export class LockError extends McpSavvyError {
    override readonly name: string = 'LockError';
    constructor(code: McpSavvyErrorCode, message: string, cause?: unknown) {
        super(code, message, cause);
    }
}
