/** Credential-bearing endpoint validation for CLI configuration. */

import { ConfigError, isSecureEndpointUrl } from '@mcp-savvy/core';

const ALLOWED_CALLBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** Reject remote credential endpoints that are neither HTTPS nor exact loopback HTTP. */
export function validateCredentialEndpoints(
    remoteUrl: string,
    issuer: string,
    completeSessionUrl: string | undefined,
): void {
    for (const [name, value] of [
        ['MCP_SAVVY_REMOTE_URL', remoteUrl],
        ['MCP_SAVVY_OIDC_ISSUER', issuer],
        ['MCP_SAVVY_COMPLETE_SESSION_URL', completeSessionUrl],
    ] as const) {
        if (value && !isSecureEndpointUrl(value)) {
            throw new ConfigError(`${name} must use HTTPS or exact loopback HTTP`);
        }
    }
}

/** Parse a callback host while keeping the listener on exact loopback names. */
export function parseCallbackHost(raw: string | undefined, fallback: string): string {
    const trimmed = raw?.trim();
    if (!trimmed) return fallback;
    if (!ALLOWED_CALLBACK_HOSTS.has(trimmed)) {
        throw new ConfigError(
            `MCP_SAVVY_CALLBACK_HOST must be 'localhost' or '127.0.0.1', got '${trimmed}'`,
        );
    }
    return trimmed;
}
