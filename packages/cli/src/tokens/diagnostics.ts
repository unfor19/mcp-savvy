/** Closed, secret-safe authentication diagnostics for credential decisions. */

import type { Logger } from '@mcp-savvy/core';
import type { CredentialReadReason, TokenStoreBackendMetadata } from '@mcp-savvy/storage';
import type { EffectiveCacheIdentity } from '../identity/index.js';

/** Stable credential freshness categories. */
export type CredentialDecisionReason =
    | 'credential-fresh'
    | 'credential-stale'
    | 'recorded-expiry-invalid';

/** Stable refresh outcome categories. */
export type RefreshDecisionReason =
    | 'refresh-succeeded'
    | 'refresh-rejected'
    | 'refresh-unavailable'
    | 'refresh-error';

/** Reasons that can exhaust credential reuse and select browser sign-in. */
export type InteractiveSignInReason =
    | CredentialReadReason
    | CredentialDecisionReason
    | RefreshDecisionReason;

/** Machine-stable authentication decision categories. */
export type AuthDecisionReason =
    | InteractiveSignInReason
    | 'lock-timeout';

/** Closed set of authentication diagnostic events and their allowlisted fields. */
export type AuthDiagnosticEvent =
    | {
        type: 'initialization';
        identity: EffectiveCacheIdentity;
        backends: TokenStoreBackendMetadata;
    }
    | {
        type: 'backend-read';
        backend: string;
        reason: CredentialReadReason;
        selected: boolean;
    }
    | {
        type: 'credential';
        reason: CredentialDecisionReason;
        hasRefreshCredential: boolean;
    }
    | { type: 'refresh'; reason: RefreshDecisionReason }
    | { type: 'interactive-sign-in'; exhaustedReason: InteractiveSignInReason }
    | { type: 'lock-timeout'; namespace: string; timeoutMs: number }
    | { type: 'reauthentication'; consumedAttempts: number; budget: number };

/** Emits only allowlisted, pre-sanitized authentication fields. */
export interface AuthDiagnosticEmitter {
    /** Report the safe effective identity and backend precedence at initialization. */
    initialization(identity: EffectiveCacheIdentity, backends: TokenStoreBackendMetadata): void;
    /** Report one classified backend read without credential contents. */
    backendRead(backend: string, reason: CredentialReadReason, selected: boolean): void;
    /** Report credential freshness and refresh-token presence. */
    credential(reason: CredentialDecisionReason, hasRefreshCredential: boolean): void;
    /** Report the categorized outcome of a refresh attempt. */
    refresh(reason: RefreshDecisionReason): void;
    /** Report the decision that exhausted reuse before browser launch. */
    interactiveSignIn(exhaustedReason: InteractiveSignInReason): void;
    /** Report namespace-lock timeout without exposing operational error details. */
    lockTimeout(namespace: string, timeoutMs: number): void;
    /** Report consumption of the process-local unauthorized-response budget. */
    reauthentication(consumedAttempts: number, budget: number): void;
}

/** Create a closed authentication diagnostic emitter backed by the stderr-only logger. */
export function createAuthDiagnosticEmitter(logger: Logger): AuthDiagnosticEmitter {
    const emit = (event: AuthDiagnosticEvent): void => emitEvent(logger, event);
    return {
        initialization: (identity, backends) => emit({ type: 'initialization', identity, backends }),
        backendRead: (backend, reason, selected) =>
            emit({ type: 'backend-read', backend, reason, selected }),
        credential: (reason, hasRefreshCredential) =>
            emit({ type: 'credential', reason, hasRefreshCredential }),
        refresh: (reason) => emit({ type: 'refresh', reason }),
        interactiveSignIn: (exhaustedReason) =>
            emit({ type: 'interactive-sign-in', exhaustedReason }),
        lockTimeout: (namespace, timeoutMs) =>
            emit({ type: 'lock-timeout', namespace, timeoutMs }),
        reauthentication: (consumedAttempts, budget) =>
            emit({ type: 'reauthentication', consumedAttempts, budget }),
    };
}

function emitEvent(logger: Logger, event: AuthDiagnosticEvent): void {
    switch (event.type) {
        case 'initialization':
            logger.debug('auth.initialization', {
                effectiveCacheIdentityFingerprint: event.identity.fingerprint,
                namespace: event.identity.namespace,
                dataDir: event.identity.dataDir,
                componentFingerprints: event.identity.componentFingerprints,
                availableBackends: event.backends.available,
                preferredBackend: event.backends.preferred,
            });
            return;
        case 'backend-read':
            logger.debug('auth.backend-read', {
                backend: event.backend,
                reason: event.reason,
                selected: event.selected,
            });
            return;
        case 'credential':
            logger.debug('auth.credential', {
                reason: event.reason,
                hasRefreshCredential: event.hasRefreshCredential,
            });
            return;
        case 'refresh': {
            const fields = { reason: event.reason };
            if (event.reason === 'refresh-error') logger.warn('auth.refresh', fields);
            else logger.debug('auth.refresh', fields);
            return;
        }
        case 'interactive-sign-in':
            logger.debug('auth.interactive-sign-in', {
                exhaustedReason: event.exhaustedReason,
            });
            return;
        case 'lock-timeout':
            logger.warn('auth.lock-timeout', {
                namespace: event.namespace,
                timeoutMs: event.timeoutMs,
                reason: 'lock-timeout',
            });
            return;
        case 'reauthentication':
            logger.warn('auth.reauthentication', {
                consumedAttempts: event.consumedAttempts,
                reauthenticationBudget: event.budget,
            });
    }
}
