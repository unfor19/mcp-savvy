/** Property tests for authentication diagnostic non-disclosure. */

import type { Logger } from '@mcp-savvy/core';
import type { CredentialReadReason } from '@mcp-savvy/storage';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { EffectiveCacheIdentity } from '../identity/index.js';
import {
    createAuthDiagnosticEmitter,
    type CredentialDecisionReason,
    type InteractiveSignInReason,
    type RefreshDecisionReason,
} from './diagnostics.js';

interface LogRecord {
    message: string;
    fields?: Record<string, unknown>;
}

interface AuthenticationSecrets {
    accessToken: string;
    refreshToken: string;
    identityToken: string;
    clientId: string;
    authorizationCode: string;
    pkceVerifier: string;
    oauthState: string;
    authorizationUrl: string;
    callbackCorrelation: string;
}

const READ_REASONS: CredentialReadReason[] = [
    'credential-found',
    'credential-missing',
    'credential-unreadable-local-entry',
    'credential-invalid',
];
const CREDENTIAL_REASONS: CredentialDecisionReason[] = [
    'credential-fresh',
    'credential-stale',
    'recorded-expiry-invalid',
];
const REFRESH_REASONS: RefreshDecisionReason[] = [
    'refresh-succeeded',
    'refresh-rejected',
    'refresh-unavailable',
    'refresh-error',
];
const INTERACTIVE_REASONS: InteractiveSignInReason[] = [
    ...READ_REASONS,
    ...CREDENTIAL_REASONS,
    ...REFRESH_REASONS,
];

const SECRET_SOURCE = fc
    .record({
        accessToken: fc.uuid(),
        refreshToken: fc.uuid(),
        identityToken: fc.uuid(),
        clientId: fc.uuid(),
        authorizationCode: fc.uuid(),
        pkceVerifier: fc.uuid(),
        oauthState: fc.uuid(),
        callbackCorrelation: fc.uuid(),
    })
    .map((values): AuthenticationSecrets => ({
        accessToken: `access-${values.accessToken}`,
        refreshToken: `refresh-${values.refreshToken}`,
        identityToken: `identity-${values.identityToken}`,
        clientId: `client-${values.clientId}`,
        authorizationCode: `code-${values.authorizationCode}`,
        pkceVerifier: `verifier-${values.pkceVerifier}`,
        oauthState: `state-${values.oauthState}`,
        authorizationUrl:
            `https://authorize.example.test/oauth?code=code-${values.authorizationCode}`
            + `&state=state-${values.oauthState}`,
        callbackCorrelation: `correlation-${values.callbackCorrelation}`,
    }));

const IDENTITY: EffectiveCacheIdentity = {
    namespace: 'safe-namespace',
    dataDir: '/safe/cache',
    fingerprint: '0123456789abcdef',
    componentFingerprints: {
        issuer: '1111111111111111',
        clientId: '2222222222222222',
        namespace: '3333333333333333',
        dataDir: '4444444444444444',
    },
};

function diagnosticPropertyLogger(): { logger: Logger; records: LogRecord[] } {
    const records: LogRecord[] = [];
    const record = (message: string, fields?: Record<string, unknown>): void => {
        records.push({ message, fields });
    };
    const logger: Logger = {
        debug: record,
        info: record,
        warn: record,
        error: record,
        child: () => logger,
    };
    return { logger, records };
}

function emitEveryEventVariant(logger: Logger): void {
    const diagnostics = createAuthDiagnosticEmitter(logger);
    diagnostics.initialization(IDENTITY, {
        available: ['keychain', 'encrypted file'],
        preferred: 'keychain',
    });
    for (const reason of READ_REASONS) diagnostics.backendRead('keychain', reason, true);
    for (const reason of CREDENTIAL_REASONS) diagnostics.credential(reason, true);
    for (const reason of REFRESH_REASONS) diagnostics.refresh(reason);
    for (const reason of INTERACTIVE_REASONS) diagnostics.interactiveSignIn(reason);
    diagnostics.lockTimeout(IDENTITY.namespace, 5_000);
    diagnostics.reauthentication(1, 1);
}

describe('authentication diagnostic non-disclosure', () => {
    it('Feature: reuse-existing-auth-session, Property 6: Diagnostics never disclose authentication secrets', () => {
        // **Validates: Requirements 7.10**
        fc.assert(
            fc.property(SECRET_SOURCE, (secrets) => {
                const captured = diagnosticPropertyLogger();
                emitEveryEventVariant(captured.logger);
                const serialized = JSON.stringify(captured.records);

                for (const secret of Object.values(secrets)) {
                    expect(serialized).not.toContain(secret);
                }
                expect(captured.records.map(({ message }) => message)).toEqual(
                    expect.arrayContaining([
                        'auth.initialization',
                        'auth.backend-read',
                        'auth.credential',
                        'auth.refresh',
                        'auth.interactive-sign-in',
                        'auth.lock-timeout',
                        'auth.reauthentication',
                    ]),
                );
                expect(serialized).toContain(IDENTITY.fingerprint);
                for (const fingerprint of Object.values(IDENTITY.componentFingerprints)) {
                    expect(serialized).toContain(fingerprint);
                }
                for (const reason of [
                    ...READ_REASONS,
                    ...CREDENTIAL_REASONS,
                    ...REFRESH_REASONS,
                    'lock-timeout',
                ]) {
                    expect(serialized).toContain(reason);
                }
            }),
            { numRuns: 100 },
        );
    });
});
