/** Supported-host compatibility tests for effective cache identity resolution. */

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../env.js';
import { resolveEffectiveCacheIdentity } from './index.js';

const SYNTHETIC_USER_CONTEXT = 'uid:4242';
const SHARED_ENV = {
    MCP_SAVVY_REMOTE_URL: 'https://tools.example.com/mcp',
    MCP_SAVVY_OIDC_ISSUER: 'https://identity.example.com/tenant',
    MCP_SAVVY_CLIENT_ID: 'supported-host-public-client',
    MCP_SAVVY_DATA_DIR: '/tmp/mcp-savvy-supported-hosts',
} satisfies NodeJS.ProcessEnv;

interface HostEnvironmentFixture {
    host: 'Kiro' | 'Codex' | 'Claude' | 'Cursor';
    env: NodeJS.ProcessEnv;
}

const HOST_ENVIRONMENT_FIXTURES: readonly HostEnvironmentFixture[] = [
    { host: 'Kiro', env: { ...SHARED_ENV } },
    { host: 'Codex', env: { ...SHARED_ENV } },
    { host: 'Claude', env: { ...SHARED_ENV } },
    { host: 'Cursor', env: { ...SHARED_ENV } },
];

function resolveHostIdentity(
    env: NodeJS.ProcessEnv,
    userContext = SYNTHETIC_USER_CONTEXT,
) {
    const config = loadConfig(env);
    return resolveEffectiveCacheIdentity({
        issuer: config.issuer,
        clientId: config.clientId,
        ...(config.tokenNamespace === undefined
            ? {}
            : { namespaceOverride: config.tokenNamespace }),
        dataDir: config.dataDir,
        userContext,
    });
}

describe('supported-host effective-cache identity compatibility', () => {
    it('resolves equivalent Kiro, Codex, Claude, and Cursor environments identically', () => {
        // **Validates: Requirements 2.3, 7.9, 8.4**
        const identities = HOST_ENVIRONMENT_FIXTURES.map(({ env }) =>
            resolveHostIdentity(env),
        );
        const expected = identities[0];

        expect(expected).toBeDefined();
        for (const [index, identity] of identities.entries()) {
            expect(identity, HOST_ENVIRONMENT_FIXTURES[index]?.host).toEqual(expected);
        }
    });

    it.each([
        ['issuer', { MCP_SAVVY_OIDC_ISSUER: 'https://other-id.example.com/tenant' }],
        ['client ID', { MCP_SAVVY_CLIENT_ID: 'different-public-client' }],
        ['namespace', { MCP_SAVVY_TOKEN_NAMESPACE: 'intentional-namespace' }],
        ['data directory', { MCP_SAVVY_DATA_DIR: '/tmp/mcp-savvy-other-host-data' }],
    ])('detects %s drift when resolving host environments', (_field, drift) => {
        // **Validates: Requirements 2.4**
        const baseline = resolveHostIdentity(SHARED_ENV);
        const drifted = resolveHostIdentity({ ...SHARED_ENV, ...drift });

        expect(drifted.fingerprint).not.toBe(baseline.fingerprint);
    });

    it('detects operating-system user-context drift', () => {
        // **Validates: Requirements 2.4**
        const baseline = resolveHostIdentity(SHARED_ENV);
        const drifted = resolveHostIdentity(SHARED_ENV, 'uid:4343');

        expect(drifted.fingerprint).not.toBe(baseline.fingerprint);
    });

    it.each([
        ['issuer', { MCP_SAVVY_OIDC_ISSUER: 'https://override-drift.example.com/tenant' }],
        ['client ID', { MCP_SAVVY_CLIENT_ID: 'override-drift-public-client' }],
    ])(
        'keeps the effective identity stable for %s drift under an authoritative namespace override',
        (field, drift) => {
            // **Validates: Requirements 2.4**
            const overrideEnv = {
                ...SHARED_ENV,
                MCP_SAVVY_TOKEN_NAMESPACE: 'shared-authoritative-namespace',
            };
            const baseline = resolveHostIdentity(overrideEnv);
            const drifted = resolveHostIdentity({ ...overrideEnv, ...drift });

            expect(drifted.namespace).toBe(baseline.namespace);
            expect(drifted.fingerprint).toBe(baseline.fingerprint);
            expect(
                drifted.componentFingerprints[field === 'issuer' ? 'issuer' : 'clientId'],
            ).not.toBe(
                baseline.componentFingerprints[field === 'issuer' ? 'issuer' : 'clientId'],
            );
        },
    );
});
