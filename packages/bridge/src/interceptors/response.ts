/**
 * Response-interceptor hook for `StdioBridge`.
 *
 * The default bridge is a verbatim pump: every JSON-RPC frame coming
 * from the remote is forwarded to the host unchanged. To support
 * higher-level flows like AgentCore Gateway 3LO completion, the
 * bridge needs a way to:
 *   - inspect a remote response,
 *   - look up the host request that triggered it,
 *   - and decide whether to forward, swallow, replace, or retry.
 *
 * That decision lives outside the bridge package — the bridge stays
 * auth-agnostic and protocol-agnostic. Callers register a
 * `ResponseInterceptor` and the bridge calls it once per remote
 * message.
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * What the bridge should do with a given remote response.
 *
 * - `forward`: pass the response to the host as-is. Default.
 * - `swallow`: drop the response. The host never sees it. Used when
 *   the interceptor has handled the situation out-of-band and the
 *   host should keep waiting (typically paired with a follow-up
 *   `retry` of the original request).
 * - `replace`: forward `message` to the host instead of the original
 *   response. Used to synthesize a successful result after handling
 *   an out-of-band flow.
 * - `retry`: re-send the original host request to the remote. The
 *   cached entry stays in place so the next response is still
 *   matched to the same originating request.
 */
export type ResponseAction =
    | { kind: 'forward' }
    | { kind: 'swallow' }
    | { kind: 'replace'; message: JSONRPCMessage }
    | { kind: 'retry' };

/** Inputs handed to a `ResponseInterceptor` for each remote message. */
export interface ResponseInterceptorInput {
    /** The message the remote just sent. */
    readonly response: JSONRPCMessage;
    /**
     * The host request that originated this response, if the bridge
     * still has it cached. `undefined` for unsolicited messages
     * (server-initiated requests, notifications, late frames).
     */
    readonly originalRequest: JSONRPCMessage | undefined;
}

/** Decide what to do with a remote response. May be sync or async. */
export type ResponseInterceptor = (
    input: ResponseInterceptorInput,
) => ResponseAction | Promise<ResponseAction>;

/** Default interceptor: forward every response unchanged. */
export const passThroughInterceptor: ResponseInterceptor = () => ({ kind: 'forward' });
