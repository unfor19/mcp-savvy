/**
 * Request-interceptor hook for `StdioBridge`.
 *
 * Symmetric to `ResponseInterceptor`, but fires on host→remote
 * messages instead of remote→host. Lets a caller:
 *   - inspect a host request before it hits the wire,
 *   - rewrite it (e.g. translate a synthetic tool name into a real
 *     one for `search-first` mode),
 *   - swallow it and synthesize a fake response (e.g. answer
 *     `tools/list` from a local cache without asking the gateway),
 *   - or pass it through unchanged.
 *
 * Like the response side, the bridge stays auth-agnostic and
 * protocol-agnostic. Callers register a `RequestInterceptor` and
 * the bridge calls it once per host message.
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * What the bridge should do with a given host request.
 *
 * - `forward`: send the request to the remote unchanged. Default.
 * - `replace`: send `message` to the remote instead. Used to rewrite
 *   a synthetic tool call into a real one. The replacement message
 *   keeps the original request id so the response correlates back.
 * - `swallow`: don't send to the remote. Caller MUST `respond` with
 *   a synthesized response message — used to answer requests
 *   locally (e.g. `tools/list` from a cached schema set).
 */
export type RequestAction =
    | { kind: 'forward' }
    | { kind: 'replace'; message: JSONRPCMessage }
    | { kind: 'swallow'; respond: JSONRPCMessage };

/** Inputs handed to a `RequestInterceptor` for each host message. */
export interface RequestInterceptorInput {
    /** The message the host just sent. */
    readonly request: JSONRPCMessage;
}

/** Decide what to do with a host request. May be sync or async. */
export type RequestInterceptor = (
    input: RequestInterceptorInput,
) => RequestAction | Promise<RequestAction>;

/** Default interceptor: forward every request unchanged. */
export const passThroughRequestInterceptor: RequestInterceptor = () => ({ kind: 'forward' });
