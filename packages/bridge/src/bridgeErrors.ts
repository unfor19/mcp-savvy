/**
 * Bridge-failure wire categorization.
 *
 * Maps an internal `Error` raised on the bridge's failure path to one
 * of three JSON-RPC `error.code` integers we put on the wire to the
 * MCP host. Lives in its own module so `stdioBridge.ts` stays small
 * and the categorization is unit-testable without a full bridge.
 */

import { AuthError, McpSavvyError } from '@mcp-savvy/core';

/** JSON-RPC `error.code` integers for synthetic bridge-failure frames (Req 5.3). */
export const BRIDGE_ERROR_CODES = {
    BRIDGE_TRANSPORT_FAILURE: -32000,
    BRIDGE_AUTH_FAILURE: -32001,
    BRIDGE_INTERCEPTOR_FAILURE: -32002,
} as const;

/** Discriminant for `BRIDGE_ERROR_CODES`; one of the three wire categories. */
export type BridgeErrorCategory = keyof typeof BRIDGE_ERROR_CODES;

/** Classify a bridge failure into one of the three wire categories. */
export function categorizeBridgeError(err: Error): BridgeErrorCategory {
    if (err instanceof AuthError) return 'BRIDGE_AUTH_FAILURE';
    if (err instanceof McpSavvyError && err.code === 'BRIDGE_INTERCEPTOR_FAILURE')
        return 'BRIDGE_INTERCEPTOR_FAILURE';
    return 'BRIDGE_TRANSPORT_FAILURE';
}
