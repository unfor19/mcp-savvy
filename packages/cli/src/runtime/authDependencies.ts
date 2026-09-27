/** Build the identity, storage, logging, and diagnostic dependency boundary. */

import os from 'node:os';
import { createLogger } from '@mcp-savvy/core';
import { AutoTokenStore } from '@mcp-savvy/storage';
import type { CommandDeps } from '../commands/index.js';
import type { CliConfig } from '../env.js';
import { resolveEffectiveCacheIdentity } from '../identity/index.js';
import { createAuthDiagnosticEmitter } from '../tokens/index.js';

type AuthDependencies = Pick<
    CommandDeps,
    | 'store'
    | 'logger'
    | 'diagnostics'
    | 'effectiveIdentity'
    | 'backendMetadata'
    | 'namespace'
>;

/** Resolve the effective identity once and wire its secret-safe observers. */
export function buildAuthenticationDependencies(config: CliConfig): AuthDependencies {
    const effectiveIdentity = resolveEffectiveCacheIdentity({
        issuer: config.issuer,
        clientId: config.clientId,
        ...(config.tokenNamespace !== undefined
            ? { namespaceOverride: config.tokenNamespace }
            : {}),
        dataDir: config.dataDir,
        userContext: resolveUserContext(),
    });
    const baseLogger = createLogger({
        name: 'mcp-savvy',
        level: config.debug ? 'debug' : 'info',
    });
    const logger = baseLogger.child({
        effectiveCacheIdentityFingerprint: effectiveIdentity.fingerprint,
        namespace: effectiveIdentity.namespace,
        dataDir: effectiveIdentity.dataDir,
        componentFingerprints: effectiveIdentity.componentFingerprints,
    });
    const diagnostics = createAuthDiagnosticEmitter(logger);
    const store = new AutoTokenStore(
        {
            namespace: effectiveIdentity.namespace,
            dataDir: effectiveIdentity.dataDir,
            onBackendRead: ({ backend, reason, selected }) =>
                diagnostics.backendRead(backend, reason, selected),
        },
        logger,
    );
    const backendMetadata = store.backendMetadata;
    diagnostics.initialization(effectiveIdentity, backendMetadata);
    return {
        store,
        logger,
        diagnostics,
        effectiveIdentity,
        backendMetadata,
        namespace: effectiveIdentity.namespace,
    };
}

function resolveUserContext(): string {
    const user = os.userInfo();
    return user.uid >= 0
        ? `uid:${user.uid}`
        : `username:${user.username}\0home:${user.homedir}`;
}
