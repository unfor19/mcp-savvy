/**
 * Unit tests for the core IdentityProvider factories.
 *
 * The constructs (Runtime, Gateway) have their own snapshot tests
 * that exercise the JWT authorizer wiring end-to-end. These tests
 * focus on the factories themselves: discovery URL composition,
 * custom-claim plumbing, hostedUiUrl normalization, and the scope
 * binding for `importCognito`'s imported user pool. Vendor presets
 * are tested separately in `idpPresets.test.ts`.
 */

import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { describe, expect, it } from 'vitest';
import { externalOidc, importCognito } from './identityProvider.js';
import { freshStack } from '../testFixtures.js';

describe('externalOidc', () => {
    it('builds a discovery URL from the issuer and trims trailing slash', () => {
        const idp = externalOidc({
            issuer: 'https://idp.example.com/',
            allowedAudience: ['mcp-api'],
        });
        expect(idp.kind).toBe('externalOidc');
        expect(idp.issuerUrl).toBe('https://idp.example.com');
        expect(idp.jwtAuthorizer.discoveryUrl).toBe(
            'https://idp.example.com/.well-known/openid-configuration',
        );
    });

    it('passes audience, scopes, and customClaim through unchanged', () => {
        const idp = externalOidc({
            issuer: 'https://login.microsoftonline.com/tenant/v2.0',
            allowedAudience: ['aud-1'],
            allowedScopes: ['openid', 'email'],
            customClaim: { name: 'azp', value: 'azp-1' },
        });
        expect(idp.jwtAuthorizer.allowedAudience).toEqual(['aud-1']);
        expect(idp.jwtAuthorizer.allowedScopes).toEqual(['openid', 'email']);
        expect(idp.jwtAuthorizer.customClaim).toEqual({ name: 'azp', value: 'azp-1' });
    });

    it('omits optional fields when not provided', () => {
        const idp = externalOidc({
            issuer: 'https://idp.example.com',
            allowedAudience: ['mcp-api'],
        });
        expect(idp.jwtAuthorizer.allowedAudience).toEqual(['mcp-api']);
        expect(idp.jwtAuthorizer.allowedClients).toBeUndefined();
        expect(idp.jwtAuthorizer.allowedScopes).toBeUndefined();
        expect(idp.jwtAuthorizer.customClaim).toBeUndefined();
    });

    it('rejects issuer-only and empty binding configurations', () => {
        expect(() => externalOidc({ issuer: 'https://idp.example.com' })).toThrow(
            'JWT authorizer requires a non-empty allowedAudience, allowedClients, or customClaim binding',
        );
        expect(() =>
            externalOidc({ issuer: 'https://idp.example.com', allowedAudience: [] }),
        ).toThrow('JWT authorizer requires');
        expect(() =>
            externalOidc({
                issuer: 'https://idp.example.com',
                customClaim: { name: 'azp', value: '   ' },
            }),
        ).toThrow('JWT authorizer requires');
    });
});

describe('importCognito', () => {
    it('produces a Cognito-shaped IdentityProvider with imported pool + client', () => {
        const stack = freshStack('ImportCase');
        const idp = importCognito(stack, 'SharedAuth', {
            userPoolId: 'us-east-1_AbCdEfGhI',
            humanClientId: 'client-xyz',
            hostedUiUrl: 'https://my-org.auth.us-east-1.amazoncognito.com',
        });
        expect(idp.kind).toBe('cognito');
        // Imported handles round-trip the IDs we passed in.
        expect(idp.userPool.userPoolId).toBe('us-east-1_AbCdEfGhI');
        expect(idp.humanClient.userPoolClientId).toBe('client-xyz');
        expect(idp.hostedUiUrl).toBe('https://my-org.auth.us-east-1.amazoncognito.com');
    });

    it('composes a Cognito-flavored issuer + discovery URL using the stack region', () => {
        const stack = freshStack('IssuerCase');
        const idp = importCognito(stack, 'SharedAuth', {
            userPoolId: 'us-east-1_AbCdEfGhI',
            humanClientId: 'client-xyz',
            hostedUiUrl: 'https://my-org.auth.us-east-1.amazoncognito.com',
        });
        expect(idp.issuerUrl).toBe(
            'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEfGhI',
        );
        expect(idp.jwtAuthorizer.discoveryUrl).toBe(
            'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEfGhI/.well-known/openid-configuration',
        );
        expect(idp.jwtAuthorizer.allowedClients).toEqual(['client-xyz']);
    });

    it('honors a region override (cross-region pool import)', () => {
        const stack = freshStack('CrossRegionCase');
        const idp = importCognito(stack, 'SharedAuth', {
            userPoolId: 'eu-west-1_PoolXYZ',
            humanClientId: 'client-eu',
            hostedUiUrl: 'https://my-org.auth.eu-west-1.amazoncognito.com',
            region: 'eu-west-1',
        });
        expect(idp.issuerUrl).toBe(
            'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_PoolXYZ',
        );
    });

    it('strips a trailing slash from hostedUiUrl', () => {
        const stack = freshStack('TrailingSlashCase');
        const idp = importCognito(stack, 'SharedAuth', {
            userPoolId: 'us-east-1_AbCdEfGhI',
            humanClientId: 'client-xyz',
            hostedUiUrl: 'https://my-org.auth.us-east-1.amazoncognito.com/',
        });
        expect(idp.hostedUiUrl).toBe('https://my-org.auth.us-east-1.amazoncognito.com');
    });

    it('does NOT add Cognito resources to the synthesized stack (pure import)', () => {
        const app = new cdk.App();
        const stack = new cdk.Stack(app, 'PureImportCase', {
            env: { account: '111111111111', region: 'us-east-1' },
        });
        importCognito(stack, 'SharedAuth', {
            userPoolId: 'us-east-1_AbCdEfGhI',
            humanClientId: 'client-xyz',
            hostedUiUrl: 'https://my-org.auth.us-east-1.amazoncognito.com',
        });
        const template = app.synth().getStackByName(stack.stackName).template as {
            Resources?: Record<string, unknown>;
        };
        // No new Cognito resources should appear — pool + client are imports.
        const resources = Object.values(template.Resources ?? {});
        const cognitoTypes = resources.filter((r) => {
            const type = (r as { Type?: string }).Type;
            return typeof type === 'string' && type.startsWith('AWS::Cognito::');
        });
        expect(cognitoTypes).toHaveLength(0);
    });

    it('returned userPool is a usable IUserPool reference', () => {
        const stack = freshStack('IUserPoolCase');
        const idp = importCognito(stack, 'SharedAuth', {
            userPoolId: 'us-east-1_AbCdEfGhI',
            humanClientId: 'client-xyz',
            hostedUiUrl: 'https://my-org.auth.us-east-1.amazoncognito.com',
        });
        // Smoke check — the returned reference satisfies IUserPool's
        // basic surface (userPoolArn is a CDK token here, but it's
        // resolvable, which is what downstream constructs rely on).
        expect(typeof idp.userPool.userPoolArn).toBe('string');
        // Confirm we can pass it to APIs that expect IUserPool.
        const fromArn = cognito.UserPool.fromUserPoolArn(
            stack,
            'RoundTrip',
            idp.userPool.userPoolArn,
        );
        expect(fromArn.userPoolId).toBeDefined();
    });
});
