/**
 * Apply a `RequestAction` returned by a `RequestInterceptor`.
 *
 * Symmetric to `interceptorDispatch.ts` but for the host→remote
 * direction. Pulled out so the bridge class stays focused on the
 * pump and so each direction can be unit-tested with a small
 * mocked surface.
 */

import type { Logger } from '@mcp-savvy/core';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { RequestAction, RequestInterceptor } from './request.js';

/** Callbacks the request dispatcher needs from the owning bridge. */
export interface RequestDispatcherCallbacks {
    /** Send a frame to the remote transport. */
    sendToRemote(msg: JSONRPCMessage): Promise<void>;
    /** Send a synthesized response back to the host transport. */
    sendToHost(msg: JSONRPCMessage): void;
}

/** Inputs for a single dispatch call. */
export interface RequestDispatchInput {
    readonly request: JSONRPCMessage;
    readonly interceptor: RequestInterceptor;
    readonly callbacks: RequestDispatcherCallbacks;
    readonly logger: Logger | undefined;
}

/**
 * Result of running the request interceptor and applying its
 * action.
 *
 * - `forward`: caller should treat the (possibly rewritten) message
 *   as the canonical request and continue with normal pump behavior
 *   (e.g. cache it in the pending map for response correlation).
 *   `outbound` is the message the bridge will actually send to the
 *   remote — same as the input on `forward`, the rewritten frame on
 *   `replace`.
 * - `swallow`: the interceptor handled the request locally and the
 *   response has already been sent to the host. Caller should NOT
 *   send anything to the remote and should NOT cache anything.
 */
export type RequestDispatchOutcome =
    | { readonly kind: 'forward'; readonly outbound: JSONRPCMessage }
    | { readonly kind: 'swallow' };

/**
 * Run the interceptor for one host message and apply the returned
 * action. Falls back to `forward` on any interceptor failure so a
 * buggy interceptor cannot strand the host.
 */
export async function dispatchRequest(
    input: RequestDispatchInput,
): Promise<RequestDispatchOutcome> {
    let action: RequestAction;
    try {
        action = await input.interceptor({ request: input.request });
    } catch (err) {
        input.logger?.error(
            `request interceptor threw, forwarding request: ${(err as Error).message}`,
        );
        action = { kind: 'forward' };
    }
    switch (action.kind) {
        case 'forward':
            return { kind: 'forward', outbound: input.request };
        case 'replace':
            input.logger?.debug('request interceptor rewrote outbound frame');
            return { kind: 'forward', outbound: action.message };
        case 'swallow':
            input.logger?.debug('request interceptor handled request locally');
            input.callbacks.sendToHost(action.respond);
            return { kind: 'swallow' };
    }
}
