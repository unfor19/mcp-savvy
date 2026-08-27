/** Unit tests for cumulative JWT client binding enforcement. */

import { describe, expect, it } from 'vitest';
import { enforceAllowedClients, enforceAllowedScopes, parseStringAllowlist } from './index.js';

const COGNITO_ISSUER =
    'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Example';
const EXTERNAL_ISSUER = 'https://idp.example.com';

describe('enforceAllowedClients', () => {
    it('accepts an external token with the expected client_id', () => {
        expect(() =>
            enforceAllowedClients({ client_id: 'desktop-client' }, ['desktop-client'], EXTERNAL_ISSUER),
        ).not.toThrow();
    });

    it.each([
        [{ client_id: 'other-client' }, 'client_id claim mismatch'],
        [{ aud: 'desktop-client' }, 'JWT missing client_id claim'],
    ] as const)('rejects an external token without the configured client binding', (payload, error) => {
        expect(() =>
            enforceAllowedClients(payload, ['desktop-client'], EXTERNAL_ISSUER),
        ).toThrow(error);
    });

    it('accepts Cognito access-token client_id and ID-token audience forms', () => {
        expect(() =>
            enforceAllowedClients(
                { token_use: 'access', client_id: 'desktop-client' },
                ['desktop-client'],
                COGNITO_ISSUER,
            ),
        ).not.toThrow();
        expect(() =>
            enforceAllowedClients(
                { token_use: 'id', aud: 'desktop-client' },
                ['desktop-client'],
                COGNITO_ISSUER,
            ),
        ).not.toThrow();
    });

    it('rejects a Cognito ID token for another app client', () => {
        expect(() =>
            enforceAllowedClients(
                { token_use: 'id', aud: ['other-client'] },
                ['desktop-client'],
                COGNITO_ISSUER,
            ),
        ).toThrow('Cognito ID token audience does not match an allowed client');
    });
});

describe('parseStringAllowlist', () => {
    it('preserves commas inside one configured identifier', () => {
        expect(parseStringAllowlist('["trusted,client"]', 'TEST_ALLOWLIST')).toEqual([
            'trusted,client',
        ]);
    });

    it.each(['"client"', '["client", 1]', '[""]', 'not-json'])(
        'rejects malformed allowlist %s',
        (raw) => {
            expect(() => parseStringAllowlist(raw, 'TEST_ALLOWLIST')).toThrow(
                'TEST_ALLOWLIST must be a JSON array of non-empty strings',
            );
        },
    );
});

describe('enforceAllowedScopes', () => {
    it.each([
        [{ scope: 'openid api.read' }, ['api.read']],
        [{ scp: 'api.read\tprofile' }, ['api.read']],
        [{}, []],
    ] as const)('accepts exact configured scope matches', (payload, allowed) => {
        expect(() => enforceAllowedScopes(payload, allowed)).not.toThrow();
    });

    it.each([{ scope: 'api.read.extra' }, { scp: 'api.write' }, {}, { scope: 1 }])(
        'rejects missing, malformed, and substring scope matches',
        (payload) => {
            expect(() => enforceAllowedScopes(payload, ['api.read'])).toThrow(
                'JWT does not contain an allowed scope',
            );
        },
    );
});
