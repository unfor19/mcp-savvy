/**
 * Snapshot + targeted assertion tests for `CognitoAuth`.
 *
 * Snapshots lock the synthesized CloudFormation against accidental
 * change; targeted `hasResourceProperties` assertions document the
 * intent (what we care about: MFA, scopes, callback URLs, branding).
 */

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { CognitoAuth } from './cognitoAuth.js';

function synth(props: Partial<ConstructorParameters<typeof CognitoAuth>[2]> = {}) {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', {
        env: { account: '111111111111', region: 'us-east-1' },
    });
    new CognitoAuth(stack, 'Auth', {
        domainPrefix: 'mcp-savvy-test',
        ...props,
    });
    return Template.fromStack(stack);
}

describe('CognitoAuth — snapshot', () => {
    it('matches the synthesized template (defaults)', () => {
        expect(synth().toJSON()).toMatchSnapshot();
    });

    it('matches the synthesized template (mfaRequired: false)', () => {
        expect(synth({ mfaRequired: false }).toJSON()).toMatchSnapshot();
    });

    it('matches the synthesized template (managedLogin: classic)', () => {
        expect(synth({ managedLogin: 'classic' }).toJSON()).toMatchSnapshot();
    });
});

describe('CognitoAuth — defaults', () => {
    it('creates exactly one user pool, one app client, one domain', () => {
        const t = synth();
        t.resourceCountIs('AWS::Cognito::UserPool', 1);
        t.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
        t.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
    });

    it('requires MFA (TOTP only) by default', () => {
        const t = synth();
        t.hasResourceProperties('AWS::Cognito::UserPool', {
            MfaConfiguration: 'ON',
            EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
        });
    });

    it('disables self-signup by default', () => {
        const t = synth();
        t.hasResourceProperties('AWS::Cognito::UserPool', {
            AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
        });
    });

    it('enforces a 12-char password policy with all character classes', () => {
        const t = synth();
        t.hasResourceProperties('AWS::Cognito::UserPool', {
            Policies: {
                PasswordPolicy: {
                    MinimumLength: 12,
                    RequireLowercase: true,
                    RequireUppercase: true,
                    RequireNumbers: true,
                    RequireSymbols: true,
                },
            },
        });
    });

    it('issues a public PKCE client (no secret) with auth-code grant + OIDC scopes', () => {
        const t = synth();
        t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
            GenerateSecret: false,
            AllowedOAuthFlows: ['code'],
            AllowedOAuthScopes: Match.arrayWith(['openid', 'email', 'profile']),
            AllowedOAuthFlowsUserPoolClient: true,
            EnableTokenRevocation: true,
        });
    });

    it('registers both localhost and 127.0.0.1 callback URLs by default', () => {
        const t = synth();
        t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
            CallbackURLs: Match.arrayWith([
                'http://localhost:33423/callback',
                'http://127.0.0.1:33423/callback',
            ]),
        });
    });

    it('uses the newer managed-login UI by default and attaches branding', () => {
        const t = synth();
        t.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
            ManagedLoginVersion: 2,
        });
        t.resourceCountIs('AWS::Cognito::ManagedLoginBranding', 1);
        t.hasResourceProperties('AWS::Cognito::ManagedLoginBranding', {
            UseCognitoProvidedValues: true,
        });
    });
});

describe('CognitoAuth — option overrides', () => {
    it('drops MFA to OPTIONAL when mfaRequired: false', () => {
        const t = synth({ mfaRequired: false });
        t.hasResourceProperties('AWS::Cognito::UserPool', {
            MfaConfiguration: 'OPTIONAL',
        });
    });

    it('omits managed-login branding when managedLogin: classic', () => {
        const t = synth({ managedLogin: 'classic' });
        t.resourceCountIs('AWS::Cognito::ManagedLoginBranding', 0);
        t.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
            ManagedLoginVersion: 1,
        });
    });

    it('honors a custom callback-URL list', () => {
        const t = synth({ extraCallbackUrls: ['http://localhost:9000/cb'] });
        t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
            CallbackURLs: ['http://localhost:9000/cb'],
        });
    });
});

describe('CognitoAuth — IdentityProvider surface', () => {
    it('exposes the Cognito-shaped IdentityProvider tag + JWT authorizer spec', () => {
        const app = new cdk.App();
        const stack = new cdk.Stack(app, 'IdpStack', {
            env: { account: '111111111111', region: 'us-east-1' },
        });
        const auth = new CognitoAuth(stack, 'Auth', { domainPrefix: 'mcp-savvy-test' });

        expect(auth.kind).toBe('cognito');
        expect(auth.jwtAuthorizer.discoveryUrl).toMatch(
            /\/\.well-known\/openid-configuration$/,
        );
        expect(auth.jwtAuthorizer.issuerUrl).toBe(auth.issuerUrl);
        expect(auth.jwtAuthorizer.allowedClients).toHaveLength(1);
    });
});
