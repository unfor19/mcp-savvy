/**
 * Wraps an `AuthProvider`, a `TokenStore`, and a `CallbackServer`
 * factory into the single `TokenProvider` callback the bridge
 * consumes. Handles cache → refresh → PKCE in that order under a
 * cross-process lock so concurrent hosts cannot race the IdP into
 * `invalid_grant`, corrupt the on-disk token file with torn writes,
 * or fire multiple browser tabs for the same `(issuer, clientId)`.
 *
 * The `forceRefresh: true` path used after a 401 from the remote
 * skips the cached credential but still re-reads the store *inside*
 * the lock so a sibling that already refreshed is observed.
 */

import type { AuthorizeBrowser, Logger, TokenData } from '@mcp-savvy/core';
import { AuthError, LockError, TokenStoreError } from '@mcp-savvy/core';
import type { AuthProvider } from '@mcp-savvy/auth';
import type { LockCoordinator, TokenStore } from '@mcp-savvy/storage';
import type { CallbackServer } from '@mcp-savvy/server';
import type {
    AuthDiagnosticEmitter,
    CredentialDecisionReason,
    InteractiveSignInReason,
    RefreshDecisionReason,
} from './diagnostics.js';

/** How long before the recorded expiry do we treat tokens as stale. */
export const REFRESH_BUFFER_MS = 60_000;

/** Hook called when a fresh PKCE flow needs to happen. Re-exported from core. */
export type { AuthorizeBrowser } from '@mcp-savvy/core';

/** Constructor inputs for `TokenManager`. */
export interface TokenManagerOptions {
    auth: AuthProvider;
    store: TokenStore;
    /** Builds a fresh callback server for each PKCE flow. */
    createCallbackServer(): CallbackServer;
    /** Called with the IdP authorize URL; defaults to `open` in CLI. */
    openBrowser?: AuthorizeBrowser;
    logger?: Logger;
    /** Closed, secret-safe authentication decision sink. */
    diagnostics?: AuthDiagnosticEmitter;
    /** Prefer an available OIDC ID token for AgentCore bearer authentication. */
    preferIdentityToken?: boolean;
    /** Clock used for deterministic recorded-expiry classification. */
    now?: () => number;
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

/** Classify a stored credential using only its recorded expiry and the supplied time. */
export function classifyCredential(tokens: TokenData, now: number): CredentialDecisionReason {
    if (!Number.isFinite(tokens.expires_at)) return 'recorded-expiry-invalid';
    return tokens.expires_at > now + REFRESH_BUFFER_MS
        ? 'credential-fresh'
        : 'credential-stale';
}

/** Manages cache → refresh → PKCE token acquisition for the bridge. */
export class TokenManager {
    private readonly auth: AuthProvider;
    private readonly store: TokenStore;
    private readonly makeServer: () => CallbackServer;
    private readonly openBrowser?: AuthorizeBrowser;
    private readonly logger: Logger | undefined;
    private readonly diagnostics: AuthDiagnosticEmitter | undefined;
    private readonly preferIdentityToken: boolean;
    private readonly now: () => number;
    private readonly lockScope: LockScope | undefined;

    constructor(opts: TokenManagerOptions) {
        this.auth = opts.auth;
        this.store = opts.store;
        this.makeServer = opts.createCallbackServer;
        if (opts.openBrowser) this.openBrowser = opts.openBrowser;
        this.logger = opts.logger;
        this.diagnostics = opts.diagnostics;
        this.preferIdentityToken = opts.preferIdentityToken ?? false;
        this.now = opts.now ?? Date.now;
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
     * Return a valid bearer token under the namespace lock.
     * AgentCore callers prefer an available ID token; generic OAuth
     * callers and bundles without one use the access token.
     */
    async getAccessToken(input: { forceRefresh: boolean }): Promise<string> {
        return this.withLock(() => this.acquireUnderLock(input));
    }

    /** Drop cached tokens while holding the namespace lock. */
    async logout(): Promise<void> {
        await this.withLock(async () => {
            await this.store.clear();
        });
    }

    /** Run `fn` under the coordinator's `withLock`, or directly if none. */
    private async withLock<T>(fn: () => Promise<T>): Promise<T> {
        const scope = this.lockScope;
        if (!scope) return fn();
        try {
            return await scope.coord.withLock(
                { namespace: scope.namespace, timeoutMs: scope.timeoutMs },
                () => fn(),
            );
        } catch (err) {
            if (err instanceof LockError && err.code === 'LOCK_ACQUISITION_TIMEOUT') {
                this.diagnostics?.lockTimeout(scope.namespace, scope.timeoutMs);
            }
            throw err;
        }
    }

    /** Cache → refresh → PKCE body executed inside the critical section. */
    private async acquireUnderLock(input: { forceRefresh: boolean }): Promise<string> {
        // Re-read after acquiring so a sibling's just-written tokens are observed.
        const cached = await this.readStore();
        if (cached) {
            const classification = classifyCredential(cached, this.now());
            this.diagnostics?.credential(classification, Boolean(cached.refresh_token));
            if (!input.forceRefresh && classification === 'credential-fresh') {
                this.logger?.debug('using cached bearer token');
                return this.selectBearer(cached);
            }
        }

        const refreshOutcome = await this.tryRefresh(cached);
        if ('tokens' in refreshOutcome) {
            await this.writeStore(refreshOutcome.tokens);
            this.diagnostics?.refresh('refresh-succeeded');
            this.logger?.debug('refreshed bearer token');
            return this.selectBearer(refreshOutcome.tokens);
        }

        this.diagnostics?.refresh(refreshOutcome.reason);
        const exhaustedReason: InteractiveSignInReason = cached
            ? refreshOutcome.reason
            : 'credential-missing';
        this.diagnostics?.interactiveSignIn(exhaustedReason);
        const tokens = await this.runPkce();
        await this.writeStore(tokens);
        return this.selectBearer(tokens);
    }

    private selectBearer(tokens: TokenData): string {
        return this.preferIdentityToken && tokens.id_token
            ? tokens.id_token
            : tokens.access_token;
    }

    /** Attempt refresh without allowing persistence failures to select PKCE. */
    private async tryRefresh(
        cached: TokenData | null,
    ): Promise<{ tokens: TokenData } | { reason: RefreshDecisionReason }> {
        if (!cached?.refresh_token) return { reason: 'refresh-unavailable' };
        try {
            return { tokens: await this.auth.refresh(cached.refresh_token) };
        } catch (err) {
            return { reason: classifyRefreshFailure(err) };
        }
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
            if (this.openBrowser) await this.openBrowser(prep.authorizeUrl);
            const result = await server.awaitCallback({ state: prep.state });
            return await this.auth.exchangeCode({
                code: result.code,
                state: result.state,
                codeVerifier: prep.codeVerifier,
                redirectUri: prep.redirectUri,
            });
        } finally {
            await server.stop();
        }
    }
}

/** Categorize a refresh failure without exposing its message or response body. */
function classifyRefreshFailure(err: unknown): RefreshDecisionReason {
    return err instanceof AuthError && err.code === 'TOKEN_REFRESH_FAILED'
        ? 'refresh-rejected'
        : 'refresh-error';
}

/** Thrown when callers ask for tokens outside a valid flow. */
export class TokenManagerError extends AuthError {
    constructor(message: string) {
        super('AUTH_PROVIDER_ERROR', message);
    }
}
