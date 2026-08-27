/**
 * Apply a `ResponseAction` returned by a `ResponseInterceptor`.
 *
 * Pulled out of `StdioBridge` to keep the bridge class focused on
 * the pump and re-auth concerns. The dispatcher takes a small
 * surface (pending map + a couple of callbacks) so it can be unit
 * tested without spinning up real transports.
 */

import type { Logger } from '@mcp-savvy/core';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
    isJSONRPCResponse,
    isJSONRPCErrorResponse,
} from '@modelcontextprotocol/sdk/types.js';
import type { ResponseAction, ResponseInterceptor } from './response.js';

/** A request id as carried by JSON-RPC. */
export type JsonRpcId = string | number;

/** Bookkeeping for a single in-flight host→remote request. */
export interface PendingRequest {
    /** The exact frame the host sent — replayed verbatim on retry. */
    readonly request: JSONRPCMessage;
    /** Number of `{ kind: 'retry' }` actions honoured so far. */
    retries: number;
}

/** Callbacks the dispatcher needs from the owning bridge. */
export interface DispatcherCallbacks {
    /** Forward a frame to the host (stdio) transport. */
    sendToHost(msg: JSONRPCMessage): void;
    /** Replay a request to the remote transport. */
    sendToRemote(msg: JSONRPCMessage): Promise<void>;
}

/** Inputs for a single dispatch call. */
export interface DispatchInput {
    readonly response: JSONRPCMessage;
    readonly pending: Map<JsonRpcId, PendingRequest>;
    readonly interceptor: ResponseInterceptor;
    readonly maxRetries: number;
    readonly callbacks: DispatcherCallbacks;
    readonly logger: Logger | undefined;
}

/**
 * Run the interceptor for one remote message and apply the returned
 * action. Falls back to `forward` on any interceptor failure so a
 * buggy interceptor cannot strand the host.
 */
export async function dispatchResponse(input: DispatchInput): Promise<void> {
    const id = correlationId(input.response);
    const entry = id !== undefined ? input.pending.get(id) : undefined;
    let action: ResponseAction;
    try {
        action = await input.interceptor({
            response: input.response,
            originalRequest: entry?.request,
        });
    } catch (err) {
        input.logger?.error(
            `interceptor threw, forwarding response: ${(err as Error).message}`,
        );
        action = { kind: 'forward' };
    }
    await applyAction(action, input, id, entry);
}

/** Dispatch the chosen `ResponseAction`. */
async function applyAction(
    action: ResponseAction,
    input: DispatchInput,
    id: JsonRpcId | undefined,
    entry: PendingRequest | undefined,
): Promise<void> {
    switch (action.kind) {
        case 'forward':
            if (id !== undefined) input.pending.delete(id);
            input.callbacks.sendToHost(input.response);
            return;
        case 'swallow':
            if (id !== undefined) input.pending.delete(id);
            return;
        case 'replace':
            if (id !== undefined) input.pending.delete(id);
            input.callbacks.sendToHost(action.message);
            return;
        case 'retry':
            await applyRetry(input, id, entry);
            return;
    }
}

/** Honour `{ kind: 'retry' }`, respecting the per-id budget. */
async function applyRetry(
    input: DispatchInput,
    id: JsonRpcId | undefined,
    entry: PendingRequest | undefined,
): Promise<void> {
    if (!entry || id === undefined) {
        input.logger?.warn(
            'interceptor returned retry but no pending request matched; forwarding',
        );
        input.callbacks.sendToHost(input.response);
        return;
    }
    if (entry.retries >= input.maxRetries) {
        input.logger?.warn(
            `interceptor retry budget exhausted for id=${String(id)}; forwarding`,
        );
        input.pending.delete(id);
        input.callbacks.sendToHost(input.response);
        return;
    }
    entry.retries += 1;
    input.logger?.debug(`interceptor retry attempt ${entry.retries} for id=${String(id)}`);
    await input.callbacks.sendToRemote(entry.request);
}

/** Extract the request `id` from a response/error frame, if any. */
export function correlationId(msg: JSONRPCMessage): JsonRpcId | undefined {
    if (isJSONRPCResponse(msg) || isJSONRPCErrorResponse(msg)) {
        return msg.id;
    }
    return undefined;
}
