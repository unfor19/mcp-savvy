/**
 * Helpers for composing multiple interceptors into one.
 *
 * The bridge accepts a single `requestInterceptor` and a single
 * `responseInterceptor`. When a deployment needs both 3LO retry
 * (gatewaySessionInterceptor) AND tool flattening (searchFirst
 * interceptors) live, it builds each independently and composes
 * them through these helpers.
 *
 * Composition policy: **first non-`forward` action wins.** Each
 * interceptor in the list is asked in order; the first one that
 * returns anything other than `{ kind: 'forward' }` short-circuits
 * the chain. This keeps composition predictable and lets callers
 * order interceptors by specificity (most-specific first).
 *
 * Errors from one interceptor don't poison the chain — the caller
 * (the bridge's dispatcher) catches and falls back to forward,
 * matching its existing single-interceptor failure mode.
 */

import type { RequestAction, RequestInterceptor } from './request.js';
import type { ResponseAction, ResponseInterceptor } from './response.js';

/**
 * Compose multiple `RequestInterceptor`s. The first non-`forward`
 * action short-circuits the chain.
 */
export function composeRequestInterceptors(
    interceptors: readonly RequestInterceptor[],
): RequestInterceptor {
    return async (input) => {
        for (const interceptor of interceptors) {
            const action: RequestAction = await interceptor(input);
            if (action.kind !== 'forward') return action;
        }
        return { kind: 'forward' };
    };
}

/**
 * Compose multiple `ResponseInterceptor`s. The first non-`forward`
 * action short-circuits the chain.
 */
export function composeResponseInterceptors(
    interceptors: readonly ResponseInterceptor[],
): ResponseInterceptor {
    return async (input) => {
        for (const interceptor of interceptors) {
            const action: ResponseAction = await interceptor(input);
            if (action.kind !== 'forward') return action;
        }
        return { kind: 'forward' };
    };
}
