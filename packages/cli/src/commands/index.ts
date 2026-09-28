/**
 * CLI commands: each accepts a fully-built `CliConfig` and the
 * env-derived `Deps` (storage, auth, server factory, bridge). They
 * return a number suitable for `process.exit`.
 *
 * Keeping the dispatch logic separate from `cli.ts` lets us unit-test
 * each command without spawning a subprocess.
 */

import { LockError, type Logger } from '@mcp-savvy/core';
import type { AuthProvider } from '@mcp-savvy/auth';
import type {
    LockCoordinator,
    TokenStore,
    TokenStoreBackendMetadata,
} from '@mcp-savvy/storage';
import type { CallbackServer } from '@mcp-savvy/server';
import type { StdioBridge, TokenProvider } from '@mcp-savvy/bridge';
import type { CliConfig } from '../env.js';
import type { EffectiveCacheIdentity } from '../identity/index.js';
import {
    classifyCredential,
    TokenManager,
    type AuthDiagnosticEmitter,
    type AuthorizeBrowser,
} from '../tokens/index.js';

/** Things commands need that aren't part of `CliConfig`. */
export interface CommandDeps {
    auth: AuthProvider;
    store: TokenStore;
    createCallbackServer(): CallbackServer;
    openBrowser?: AuthorizeBrowser;
    /** Build the bridge given the access-token provider. */
    createBridge(getAccessToken: TokenProvider): StdioBridge;
    logger: Logger;
    /** Closed, secret-safe authentication decision sink. */
    diagnostics: AuthDiagnosticEmitter;
    /** Canonical identity shared by storage, locking, and diagnostics. */
    effectiveIdentity: EffectiveCacheIdentity;
    /** Available token backends and their deterministic precedence. */
    backendMetadata: TokenStoreBackendMetadata;
    /** Single shared cross-process mutex for token-store mutations. */
    lock: LockCoordinator;
    /** Token Namespace shared by store, lock, and PKCE flows. */
    namespace: string;
    /** Per-acquisition lock timeout from `CliConfig.lockTimeoutMs`. */
    lockTimeoutMs: number;
    /** Prefer OIDC ID tokens for AgentCore while retaining access-token fallback. */
    preferIdentityToken: boolean;
}

/** Build a `TokenManager` from the production `CommandDeps`. */
function makeTokenManager(deps: CommandDeps): TokenManager {
    return new TokenManager({
        auth: deps.auth,
        store: deps.store,
        createCallbackServer: deps.createCallbackServer,
        ...(deps.openBrowser ? { openBrowser: deps.openBrowser } : {}),
        logger: deps.logger,
        diagnostics: deps.diagnostics,
        lock: deps.lock,
        namespace: deps.namespace,
        lockTimeoutMs: deps.lockTimeoutMs,
        preferIdentityToken: deps.preferIdentityToken,
    });
}

/** Run a CLI authentication command under the namespace lock with timeout diagnostics. */
async function withCommandLock<T>(deps: CommandDeps, fn: () => Promise<T>): Promise<T> {
    try {
        return await deps.lock.withLock(
            { namespace: deps.namespace, timeoutMs: deps.lockTimeoutMs },
            fn,
        );
    } catch (err) {
        if (err instanceof LockError && err.code === 'LOCK_ACQUISITION_TIMEOUT') {
            deps.diagnostics.lockTimeout(deps.namespace, deps.lockTimeoutMs);
        }
        throw err;
    }
}

/**
 * `runBridge` — the default command. Acquire tokens, then forward
 * stdio↔Streamable-HTTP until the host disconnects.
 */
export async function runBridge(_config: CliConfig, deps: CommandDeps): Promise<number> {
    const tokens = makeTokenManager(deps);
    const bridge = deps.createBridge((input) => tokens.getAccessToken(input));
    await bridge.run();
    return 0;
}

/**
 * `--login` — cache-first sign-in. Returns immediately when the
 * cached access_token still has more than `REFRESH_BUFFER_MS` of
 * lifetime; otherwise refreshes (if a refresh_token is present) or
 * runs PKCE. The whole flow runs under a single outer lock
 * acquisition so the cache check and the subsequent acquisition
 * cannot race a sibling process; the inner `TokenManager` re-enters
 * the same handle via `LockCoordinator.withLock`'s reentry path.
 */
export async function login(_config: CliConfig, deps: CommandDeps): Promise<number> {
    const tokens = makeTokenManager(deps);
    return withCommandLock(deps, async () => {
        const cached = await deps.store.get();
        const now = Date.now();
        if (cached) {
            const classification = classifyCredential(cached, now);
            deps.diagnostics.credential(classification, Boolean(cached.refresh_token));
            if (classification === 'credential-fresh') {
                deps.logger.info('already signed in', {
                    remainingMs: cached.expires_at - now,
                });
                return 0;
            }
        }
        await tokens.getAccessToken({ forceRefresh: false });
        deps.logger.info('signed in; tokens cached');
        return 0;
    });
}

/**
 * `--force-login` — clear cached tokens and run PKCE unconditionally.
 * The clear and the PKCE acquisition both happen inside the same
 * outer lock acquisition so a sibling cannot read tokens between the
 * clear and the new write; the inner `TokenManager.getAccessToken`
 * re-enters the same handle via `LockCoordinator.withLock`.
 */
export async function forceLogin(_config: CliConfig, deps: CommandDeps): Promise<number> {
    const tokens = makeTokenManager(deps);
    return withCommandLock(deps, async () => {
        await deps.store.clear();
        await tokens.getAccessToken({ forceRefresh: false });
        deps.logger.info('signed in; tokens cached');
        return 0;
    });
}

/** `--logout` — clear cached tokens and exit. */
export async function logout(_config: CliConfig, deps: CommandDeps): Promise<number> {
    const tokens = makeTokenManager(deps);
    await tokens.logout();
    deps.logger.info('cached tokens cleared');
    return 0;
}

/** `--print-env` — report resolved, secret-safe config without authentication side effects. */
export async function printEnv(config: CliConfig, deps: CommandDeps): Promise<number> {
    const safe = {
        provider: config.provider,
        remoteUrl: config.remoteUrl,
        issuer: config.issuer,
        scopes: config.scopes,
        callbackHost: config.callbackHost,
        callbackPort: config.callbackPort,
        callbackPath: config.callbackPath,
        namespace: deps.effectiveIdentity.namespace,
        dataDir: deps.effectiveIdentity.dataDir,
        effectiveCacheIdentityFingerprint: deps.effectiveIdentity.fingerprint,
        componentFingerprints: deps.effectiveIdentity.componentFingerprints,
        availableBackends: deps.backendMetadata.available,
        preferredBackend: deps.backendMetadata.preferred,
        brandName: config.brandName,
        completeSessionUrl: config.completeSessionUrl,
        bearerPreference: config.bearerPreference,
        resolvedBearerPreference: deps.preferIdentityToken ? 'id' : 'access',
        toolMode: config.toolMode,
        toolPrefix: config.toolPrefix,
        debug: config.debug,
    };
    deps.logger.info('resolved config', safe);
    return 0;
}
