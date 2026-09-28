/** Tests for the closed, allowlisted authentication diagnostic model. */

import { createLogger, type Logger } from '@mcp-savvy/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveCacheIdentity } from '../identity/index.js';
import { createAuthDiagnosticEmitter } from './diagnostics.js';

interface LogRecord {
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    fields?: Record<string, unknown>;
}

function diagnosticRecordingLogger(): { logger: Logger; records: LogRecord[] } {
    const records: LogRecord[] = [];
    const record = (level: LogRecord['level']) =>
        (message: string, fields?: Record<string, unknown>): void => {
            records.push({ level, message, fields });
        };
    const logger: Logger = {
        debug: record('debug'),
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
        child: () => logger,
    };
    return { logger, records };
}

const IDENTITY: EffectiveCacheIdentity = {
    namespace: 'issuer-example-12345678',
    dataDir: '/safe/cache',
    fingerprint: '0123456789abcdef',
    componentFingerprints: {
        issuer: '1111111111111111',
        clientId: '2222222222222222',
        namespace: '3333333333333333',
        dataDir: '4444444444444444',
    },
};

afterEach(() => {
    vi.restoreAllMocks();
});

describe('createAuthDiagnosticEmitter', () => {
    it('emits every event with only its allowlisted fields and required severity', () => {
        const { logger, records } = diagnosticRecordingLogger();
        const diagnostics = createAuthDiagnosticEmitter(logger);

        diagnostics.initialization(IDENTITY, {
            available: ['macOS keychain', 'encrypted file'],
            preferred: 'macOS keychain',
        });
        diagnostics.backendRead('macOS keychain', 'credential-invalid', false);
        diagnostics.credential('credential-stale', true);
        diagnostics.refresh('refresh-succeeded');
        diagnostics.refresh('refresh-error');
        diagnostics.interactiveSignIn('refresh-rejected');
        diagnostics.lockTimeout(IDENTITY.namespace, 5_000);
        diagnostics.reauthentication(1, 1);

        expect(records).toEqual([
            {
                level: 'debug',
                message: 'auth.initialization',
                fields: {
                    effectiveCacheIdentityFingerprint: IDENTITY.fingerprint,
                    namespace: IDENTITY.namespace,
                    dataDir: IDENTITY.dataDir,
                    componentFingerprints: IDENTITY.componentFingerprints,
                    availableBackends: ['macOS keychain', 'encrypted file'],
                    preferredBackend: 'macOS keychain',
                },
            },
            {
                level: 'debug',
                message: 'auth.backend-read',
                fields: {
                    backend: 'macOS keychain',
                    reason: 'credential-invalid',
                    selected: false,
                },
            },
            {
                level: 'debug',
                message: 'auth.credential',
                fields: { reason: 'credential-stale', hasRefreshCredential: true },
            },
            {
                level: 'debug',
                message: 'auth.refresh',
                fields: { reason: 'refresh-succeeded' },
            },
            {
                level: 'warn',
                message: 'auth.refresh',
                fields: { reason: 'refresh-error' },
            },
            {
                level: 'debug',
                message: 'auth.interactive-sign-in',
                fields: { exhaustedReason: 'refresh-rejected' },
            },
            {
                level: 'warn',
                message: 'auth.lock-timeout',
                fields: {
                    namespace: IDENTITY.namespace,
                    timeoutMs: 5_000,
                    reason: 'lock-timeout',
                },
            },
            {
                level: 'warn',
                message: 'auth.reauthentication',
                fields: { consumedAttempts: 1, reauthenticationBudget: 1 },
            },
        ]);
    });

    it('does not accept or emit token-bearing objects or operational error details', () => {
        const { logger, records } = diagnosticRecordingLogger();
        const diagnostics = createAuthDiagnosticEmitter(logger);
        const secrets = [
            'access-secret',
            'refresh-secret',
            'identity-secret',
            'authorization-code',
            'pkce-verifier',
            'oauth-state',
            'https://issuer.example/authorize?state=oauth-state',
            'callback-correlation',
            'complete-client-id',
            'raw-provider-error',
        ];

        diagnostics.initialization(IDENTITY, {
            available: ['encrypted file'],
            preferred: 'encrypted file',
        });
        diagnostics.backendRead('encrypted file', 'credential-found', true);
        diagnostics.credential('credential-fresh', true);
        diagnostics.refresh('refresh-rejected');
        diagnostics.interactiveSignIn('refresh-rejected');
        diagnostics.lockTimeout(IDENTITY.namespace, 1_000);
        diagnostics.reauthentication(1, 1);

        const serialized = JSON.stringify(records);
        for (const secret of secrets) expect(serialized).not.toContain(secret);
    });

    it('writes through the logger to stderr and leaves MCP stdout untouched', () => {
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const diagnostics = createAuthDiagnosticEmitter(
            createLogger({ name: 'diagnostics-test', level: 'debug', format: 'json' }),
        );

        diagnostics.credential('credential-fresh', false);
        diagnostics.lockTimeout(IDENTITY.namespace, 500);

        expect(stdout).not.toHaveBeenCalled();
        expect(stderr).toHaveBeenCalledTimes(2);
        const output = stderr.mock.calls.map((call) => String(call[0])).join('');
        expect(output).toContain('auth.credential');
        expect(output).toContain('auth.lock-timeout');
    });
});
