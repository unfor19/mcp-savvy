/**
 * Wraps an `AuthProvider`, a `TokenStore`, and a `CallbackServer`
 * factory into the single `TokenProvider` callback the bridge
 * consumes. Handles cache → refresh → PKCE in that order under a
 * cross-process lock so concurrent hosts cannot race the IdP into
 * `invalid_grant`, corrupt the on-disk token file with torn writes,
 * or fire multiple browser tabs for the same `(issuer, clientId)`.
 *
 * The `forceRefresh: true` path used after a 401 from the remote
 * skips the cached access_token but still re-reads the store
 * *inside* the lock so a sibling that already refreshed is observed.
 */

import type { AuthorizeBrowser, Logger, TokenData } from '@mcp-savvy/core';
import { AuthError, TokenStoreError } from '@mcp-savvy/core';
import type { AuthProvider } from '@mcp-savvy/auth';
import type { LockCoordinator, TokenStore } from '@mcp-savvy/storage';
import type { CallbackServer } from '@mcp-savvy/server';

/** How long before the recorded expiry do we treat tokens as stale. */
export const REFRESH_BUFFER_MS = 60_000;

/** Hook called when a fresh PKCE flow needs to happen. Re-exported from core. */
export type { AuthorizeBrowser } from '@mcp-savvy/core';

/** Constructor inputs for `TokenManager`. */
export interface TokenManagerOptions {
    auth: AuthProvider;
    store: TokenStore;
    /**
     * Builds a fresh callback server for each PKCE flow. We make a
     * new instance per flow so a stale server from an aborted
     * sign-in cannot capture the next code.
     */
    createCallbackServer(): CallbackServer;
    /** Called with the IdP authorize URL; defaults to `open` in CLI. */
    openBrowser?: AuthorizeBrowser;
    logger?: Logger;
    /**
     * Cross-process mutex coordinating every token-store mutation.
     * Production wiring (`buildDeps`) always supplies one; in-package
     * unit tests may omit it to focus on cache/refresh/PKCE branching.
     * When set, `namespace` and `lockTimeoutMs` MUST also be set.
     */
    lock?: LockCoordinator;
    /** Token Namespace consumed by `LockCoordinator.acquire`. */
    namespace?: string;
    /** Per-acquisition timeout for the lock, in milliseconds. */
    lockTimeoutMs?: number;
}

/** Internal record bundling the coordinator with its required scope. */
interface LockScope {
    coord: LockCoordinator;
    namespace: string;
    timeoutMs: number;
}

/**
 * Manages tokens for the bridge. Exposes `getAccessToken` matching
 * the bridge's `TokenProvider` signature.
 */
export class TokenManager {
    private readonly auth: AuthProvider;
    private readonly store: TokenStore;
    private readonly makeServer: () => CallbackServer;
    private readonly openBrowser?: AuthorizeBrowser;
    private readonly logger: Logger | undefined;
    private readonly lockScope: LockScope | undefined;

    constructor(opts: TokenManagerOptions) {
        this.auth = opts.auth;
        this.store = opts.store;
        this.makeServer = opts.createCallbackServer;
        if (opts.openBrowser) this.openBrowser = opts.openBrowser;
        this.logger = opts.logger;
        if (opts.lock !== undefined) {
            if (opts.namespace === undefined || opts.lockTimeoutMs === undefined) {
                throw new Error(
                    'TokenManager: `lock` requires `namespace` and `lockTimeoutMs` to also be set',
                );
            }
            this.lockScope = {
                coord: opts.lock,
                namespace: opts.namespace,
                timeoutMs: opts.lockTimeoutMs,
            };
        }
    }

    /**
     * Return a valid access_token. With `forceRefresh: false` we
     * use cached tokens when fresh; otherwise we refresh; otherwise
     * we run PKCE. With `forceRefresh: true` we skip the cached
     * access_token but still try the refresh_token first.
     *
     * The whole body runs under `lock.withLock` so concurrent
     * processes cannot duplicate PKCE or invalidate each other's
     * rotating refresh tokens. A `LockError('LOCK_ACQUISITION_TIMEOUT')`
     * from the wrapper propagates directly with no store mutation.
     */
    async getAccessToken(input: { forceRefresh: boolean }): Promise<string> {
        return this.withLock(() => this.acquireUnderLock(input));
    }

    /**
     * Drop any cached tokens. Used by `--logout`. Wrapped in the
     * lock so a get-then-clear interleaving from a sibling process
     * cannot read tokens we have already decided to clear.
     */
    async logout(): Promise<void> {
        await this.withLock(async () => {
            await this.store.clear();
        });
    }

    /** Run `fn` under the coordinator's `withLock`, or directly if none. */
    private async withLock<T>(fn: () => Promise<T>): Promise<T> {
        const scope = this.lockScope;
        if (!scope) return fn();
        return scope.coord.withLock(
            { namespace: scope.namespace, timeoutMs: scope.timeoutMs },
            () => fn(),
        );
    }

    /** Cache → refresh → PKCE body executed inside the critical section. */
    private async acquireUnderLock(input: { forceRefresh: boolean }): Promise<string> {
        // Re-read after acquiring so a sibling's just-written tokens are observed (Req 1.5).
        const cached = await this.readStore();
        if (!input.forceRefresh && isFresh(cached)) {
            this.logger?.debug('using cached access token');
            return cached.access_token;
        }
        if (cached?.refresh_token) {
            try {
                const refreshed = await this.auth.refresh(cached.refresh_token);
                await this.writeStore(refreshed);
                this.logger?.debug('refreshed access token');
                return refreshed.access_token;
            } catch (err) {
                this.logger?.warn(
                    `refresh failed, falling back to PKCE: ${(err as Error).message}`,
                );
            }
        }
        const tokens = await this.runPkce();
        await this.writeStore(tokens);
        return tokens.access_token;
    }

    /** Read the store, wrapping non-TokenStoreError failures as `TOKEN_STORE_READ_FAILED`. */
    private async readStore(): Promise<TokenData | null> {
        try {
            return await this.store.get();
        } catch (err) {
            if (err instanceof TokenStoreError) throw err;
            throw new TokenStoreError(
                'TOKEN_STORE_READ_FAILED',
                `failed to read token store: ${(err as Error).message}`,
                err,
            );
        }
    }

    /** Persist the bundle, wrapping non-TokenStoreError failures as `TOKEN_STORE_WRITE_FAILED`. */
    private async writeStore(tokens: TokenData): Promise<void> {
        try {
            await this.store.set(tokens);
        } catch (err) {
            if (err instanceof TokenStoreError) throw err;
            throw new TokenStoreError(
                'TOKEN_STORE_WRITE_FAILED',
                `failed to write token store: ${(err as Error).message}`,
                err,
            );
        }
    }

    /** One round of PKCE. Times out via the callback server. */
    private async runPkce(): Promise<TokenData> {
        const prep = await this.auth.prepareAuthorize();
        const server = this.makeServer();
        await server.listen();
        try {
            this.logger?.info('opening browser for sign-in');
            if (this.openBrowser) {
                await this.openBrowser(prep.authorizeUrl);
            }
            const result = await server.awaitCallback({ state: prep.state });
            const tokens = await this.auth.exchangeCode({
                code: result.code,
                state: result.state,
                codeVerifier: prep.codeVerifier,
                redirectUri: prep.redirectUri,
            });
            return tokens;
        } finally {
            await server.stop();
        }
    }
}

/** True if the cached bundle has more than the refresh buffer left. */
function isFresh(tokens: TokenData | null): tokens is TokenData {
    if (!tokens) return false;
    return tokens.expires_at > Date.now() + REFRESH_BUFFER_MS;
}

/** Thrown when callers ask for tokens outside a valid flow. */
export class TokenManagerError extends AuthError {
    constructor(message: string) {
        super('AUTH_PROVIDER_ERROR', message);
    }
}
