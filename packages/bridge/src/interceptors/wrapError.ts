/**
 * Wrap errors that escape an interceptor body as `BRIDGE_INTERCEPTOR_FAILURE`.
 *
 * Interceptors run inside the bridge's host→remote / remote→host
 * pump. When a body's logic raises, the dispatcher catches the
 * error and (after Phase 6.1) hands it to `failHost(err)`, which
 * categorizes via `categorizeBridgeError` into one of the
 * `BRIDGE_ERROR_CODES` slots for the synthetic JSON-RPC error frame.
 *
 * Categorization is by error type:
 *   - `AuthError` (and its subclasses) → `BRIDGE_AUTH_FAILURE`
 *   - `McpSavvyError` with `code === 'BRIDGE_INTERCEPTOR_FAILURE'`
 *     → `BRIDGE_INTERCEPTOR_FAILURE`
 *   - anything else → `BRIDGE_TRANSPORT_FAILURE`
 *
 * Without this helper, a generic `Error` thrown from a search-first
 * or 3LO interceptor would be miscategorized as a transport
 * failure. We wrap once at the outer boundary of each interceptor
 * body so the categorization is deterministic, while leaving
 * already-typed errors (`AuthError`, other `McpSavvyError`s) alone
 * so they keep their own category.
 */

import { McpSavvyError } from '@mcp-savvy/core';

/**
 * Coerce a thrown value into a typed `McpSavvyError` suitable for
 * the bridge's failure-categorization logic. Existing
 * `McpSavvyError` instances (including `AuthError`) pass through
 * unchanged so they retain their own `code`.
 */
export function asInterceptorFailure(err: unknown): Error {
    if (err instanceof McpSavvyError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new McpSavvyError('BRIDGE_INTERCEPTOR_FAILURE', message, err);
}
