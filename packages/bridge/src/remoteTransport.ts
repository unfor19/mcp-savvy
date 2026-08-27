/**
 * Remote-transport plumbing for `StdioBridge`.
 *
 * Lives in its own module so `stdioBridge.ts` stays under fon's
 * 300-line limit. Two helpers:
 *
 *   - `defaultRemoteTransport` builds the production Streamable-HTTP
 *     transport with the bearer token (and optional pinned
 *     `mcp-protocol-version` header).
 *   - `errorStatus` digs the HTTP status code out of an SDK transport
 *     error so the bridge's 401 reauth branch can fire.
 */

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isSecureEndpointUrl } from '@mcp-savvy/core';

/** Factory for the remote (client-side) transport given a Bearer token. */
export type RemoteTransportFactory = (token: string) => Transport;

/** Return the HTTP status carried by a transport error, or null. */
export function errorStatus(err: unknown): number | null {
    if (typeof err !== 'object' || err === null) return null;
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'number') return code;
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number') return status;
    // The SDK's StreamableHTTPError stashes status on `code`.
    return null;
}

/** Default factory for the remote transport. */
export function defaultRemoteTransport(
    url: string,
    mcpProtocolVersion: string | undefined,
): RemoteTransportFactory {
    if (!isSecureEndpointUrl(url)) {
        throw new TypeError('remote MCP endpoint must use HTTPS or exact loopback HTTP');
    }
    return (token: string) => {
        const headers: Record<string, string> = { authorization: `Bearer ${token}` };
        if (mcpProtocolVersion) headers['mcp-protocol-version'] = mcpProtocolVersion;
        return new StreamableHTTPClientTransport(new URL(url), {
            requestInit: { headers },
            fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
        });
    };
}
