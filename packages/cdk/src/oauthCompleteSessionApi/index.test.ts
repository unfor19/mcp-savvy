/**
 * Snapshot + targeted assertion tests for `OAuthCompleteSessionApi`.
 *
 * Snapshots lock the synthesized CloudFormation against accidental
 * change; targeted `hasResourceProperties` assertions document the
 * intent: REST API + Lambda authorizer wiring, the env-var contract
 * fed to the authorizer Lambda, the workload-identity custom
 * resource, and the IAM permissions on the complete-session Lambda.
 *
 * Asset hashes vary with the bundled Lambda zip contents; the
 * tests filter them out so changes to `node_modules` versions
 * don't churn snapshots.
 */

import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { OAuthCompleteSessionApi } from './index.js';
import { externalOidc } from '../identity/identityProvider.js';
import {
    freshStack,
    stackWithCognitoAuth,
    stackWithEntraIdp,
} from '../testFixtures.js';

const FAKE_GATEWAY_ID = "mcp-savvy-test-gateway";

function synthCognitoCompleteSession() {
    const { stack, auth } = stackWithCognitoAuth();
    new OAuthCompleteSessionApi(stack, 'OAuthComplete', {
        identityProvider: auth,
        gatewayId: FAKE_GATEWAY_ID,
    });
    return Template.fromStack(stack);
}

function synthEntraCompleteSession() {
    const { stack, idp } = stackWithEntraIdp();
    new OAuthCompleteSessionApi(stack, 'OAuthComplete', {
        identityProvider: idp,
        gatewayId: FAKE_GATEWAY_ID,
    });
    return Template.fromStack(stack);
}

describe('OAuthCompleteSessionApi — defaults', () => {
    it('creates one REST API, one resource, one POST method (plus OPTIONS preflight)', () => {
        const t = synthCognitoCompleteSession();
        t.resourceCountIs('AWS::ApiGateway::RestApi', 1);
        // /complete-session resource (root is implicit, not a separate resource).
        t.resourceCountIs('AWS::ApiGateway::Resource', 1);
        t.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'complete-session' });
        // Methods: one POST on /complete-session, plus CORS OPTIONS
        // preflights that CDK attaches to both the root and the
        // resource. No GET / PUT / DELETE.
        const methods = t.findResources('AWS::ApiGateway::Method');
        const verbs = Object.values(methods).map(
            (m) => (m as { Properties: { HttpMethod: string } }).Properties.HttpMethod,
        );
        expect(verbs.filter((v) => v === 'POST')).toHaveLength(1);
        expect(verbs.filter((v) => v !== 'POST').every((v) => v === 'OPTIONS')).toBe(true);
    });

    it('uses a Lambda authorizer of TYPE TOKEN, not COGNITO_USER_POOLS', () => {
        const t = synthCognitoCompleteSession();
        t.hasResourceProperties('AWS::ApiGateway::Authorizer', {
            Type: 'TOKEN',
            IdentitySource: 'method.request.header.Authorization',
        });
        // No native Cognito user-pool authorizer should appear.
        const auths = t.findResources('AWS::ApiGateway::Authorizer');
        const types = Object.values(auths).map(
            (a) => (a as { Properties: { Type: string } }).Properties.Type,
        );
        expect(types).not.toContain('COGNITO_USER_POOLS');
    });

    it('configures the POST method with CUSTOM authorization (Lambda authorizer)', () => {
        synthCognitoCompleteSession().hasResourceProperties('AWS::ApiGateway::Method', {
            HttpMethod: 'POST',
            AuthorizationType: 'CUSTOM',
            AuthorizerId: Match.anyValue(),
        });
    });

    it('publishes a v1 stage with throttling defaults (100 / 200)', () => {
        synthCognitoCompleteSession().hasResourceProperties('AWS::ApiGateway::Stage', {
            StageName: 'v1',
            MethodSettings: Match.arrayWith([
                Match.objectLike({ ThrottlingRateLimit: 100, ThrottlingBurstLimit: 200 }),
            ]),
        });
    });

    it('honors a throttling override', () => {
        const { stack, auth } = stackWithCognitoAuth('ThrottleCase');
        new OAuthCompleteSessionApi(stack, 'OAuthComplete', {
            identityProvider: auth,
            gatewayId: FAKE_GATEWAY_ID,
            throttling: { rateLimit: 5, burstLimit: 10 },
        });
        Template.fromStack(stack).hasResourceProperties('AWS::ApiGateway::Stage', {
            MethodSettings: Match.arrayWith([
                Match.objectLike({ ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 }),
            ]),
        });
    });
});

describe('OAuthCompleteSessionApi — Lambda env contract', () => {
    it('feeds Cognito issuer + audience(=client ID) to the JWT authorizer', () => {
        const t = synthCognitoCompleteSession();
        // The authorizer Lambda is the one that exposes OIDC_*. Other
        // functions (the complete-session handler, the AwsCustomResource
        // worker) don't carry these env vars.
        const fns = t.findResources('AWS::Lambda::Function');
        const authorizerFn = Object.values(fns).find((fn) => {
            const env = (fn as { Properties: { Environment?: { Variables?: Record<string, unknown> } } })
                .Properties.Environment?.Variables;
            return env !== undefined && 'OIDC_ISSUER' in env;
        }) as { Properties: { Environment: { Variables: Record<string, unknown> } } } | undefined;
        expect(authorizerFn).toBeDefined();
        const env = authorizerFn!.Properties.Environment.Variables;
        // Cognito issuer is composed via Fn::Join in CDK tokens — match shape, not literal.
        expect(env['OIDC_ISSUER']).toBeDefined();
        expect(env['OIDC_ALLOWED_AUDIENCE']).toBe('[]');
        expect(env['OIDC_ALLOWED_CLIENTS']).toBeDefined();
        // Cognito branch: no customClaim, so the client-claim vars are absent.
        expect(env['OIDC_CLIENT_CLAIM_NAME']).toBeUndefined();
        expect(env['OIDC_CLIENT_CLAIM_VALUE']).toBeUndefined();
    });

    it('feeds Entra issuer + audience + azp to the JWT authorizer', () => {
        const t = synthEntraCompleteSession();
        const fns = t.findResources('AWS::Lambda::Function');
        const authorizerFn = Object.values(fns).find((fn) => {
            const env = (fn as { Properties: { Environment?: { Variables?: Record<string, unknown> } } })
                .Properties.Environment?.Variables;
            return env !== undefined && 'OIDC_CLIENT_CLAIM_VALUE' in env;
        }) as { Properties: { Environment: { Variables: Record<string, unknown> } } } | undefined;
        expect(authorizerFn).toBeDefined();
        const env = authorizerFn!.Properties.Environment.Variables;
        expect(env['OIDC_ISSUER']).toBe(
            'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0',
        );
        expect(env['OIDC_ALLOWED_AUDIENCE']).toBe(
            '["11111111-1111-1111-1111-111111111111"]',
        );
        expect(env['OIDC_ALLOWED_CLIENTS']).toBe('[]');
        expect(env['OIDC_CLIENT_CLAIM_NAME']).toBe('azp');
        expect(env['OIDC_CLIENT_CLAIM_VALUE']).toBe('11111111-1111-1111-1111-111111111111');
    });

    it('propagates audience and client bindings as cumulative controls', () => {
        const stack = freshStack('CumulativeBindings');
        const idp = externalOidc({
            issuer: 'https://idp.example.com',
            allowedAudience: ['mcp-api'],
            allowedClients: ['desktop-client'],
            allowedScopes: ['api.read'],
        });
        new OAuthCompleteSessionApi(stack, 'OAuthComplete', {
            identityProvider: idp,
            gatewayId: FAKE_GATEWAY_ID,
        });
        const fns = Template.fromStack(stack).findResources('AWS::Lambda::Function');
        const authorizerFn = Object.values(fns).find((fn) => {
            const env = (fn as { Properties: { Environment?: { Variables?: Record<string, unknown> } } })
                .Properties.Environment?.Variables;
            return env !== undefined && 'OIDC_ALLOWED_CLIENTS' in env;
        }) as { Properties: { Environment: { Variables: Record<string, unknown> } } } | undefined;
        const env = authorizerFn?.Properties.Environment.Variables;
        expect(env?.['OIDC_ALLOWED_AUDIENCE']).toBe('["mcp-api"]');
        expect(env?.['OIDC_ALLOWED_CLIENTS']).toBe('["desktop-client"]');
        expect(env?.['OIDC_ALLOWED_SCOPES']).toBe('["api.read"]');
    });

    it('rejects an unbound structural identity provider at the construct boundary', () => {
        const stack = freshStack('StructuralBypass');
        const unboundIdp = {
            kind: 'externalOidc',
            issuerUrl: 'https://idp.example.com',
            jwtAuthorizer: {
                issuerUrl: 'https://idp.example.com',
                discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
            },
        } as const;
        expect(
            () =>
                new OAuthCompleteSessionApi(stack, 'OAuthComplete', {
                    identityProvider: unboundIdp,
                    gatewayId: FAKE_GATEWAY_ID,
                }),
        ).toThrow('JWT authorizer requires');
    });
});

describe('OAuthCompleteSessionApi — IAM', () => {
    it('grants CompleteResourceTokenAuth on * to the complete-session Lambda', () => {
        synthCognitoCompleteSession().hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({
                        Action: 'bedrock-agentcore:CompleteResourceTokenAuth',
                        Effect: 'Allow',
                        Resource: '*',
                    }),
                ]),
            },
        });
    });

    it('grants GetGateway + UpdateWorkloadIdentity on * to the register-return-urls Lambda', () => {
        synthCognitoCompleteSession().hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({
                        Action: [
                            'bedrock-agentcore:GetGateway',
                            'bedrock-agentcore:UpdateWorkloadIdentity',
                        ],
                        Effect: 'Allow',
                        Resource: '*',
                    }),
                ]),
            },
        });
    });
});

describe('OAuthCompleteSessionApi — workload-identity registration', () => {
    it('emits a custom resource carrying the gateway id and default loopback URLs', () => {
        const t = synthCognitoCompleteSession();
        const customResources = t.findResources('Custom::OAuthCompleteRegisterReturnUrls');
        expect(Object.keys(customResources).length).toBe(1);
        const stringified = JSON.stringify(customResources);
        // Default URLs registered — port 33424 (3LO leg, distinct from
        // the first-leg 33423 used for `/callback`).
        expect(stringified).toContain('http://localhost:33424/oauth2/callback');
        expect(stringified).toContain('http://127.0.0.1:33424/oauth2/callback');
        // The gateway id we passed lands in the GatewayId property.
        expect(stringified).toContain(FAKE_GATEWAY_ID);
    });

    it('honors a custom loopback URL list', () => {
        const { stack, auth } = stackWithCognitoAuth('CustomLoopbackCase');
        new OAuthCompleteSessionApi(stack, 'OAuthComplete', {
            identityProvider: auth,
            gatewayId: FAKE_GATEWAY_ID,
            loopbackCallbackUrls: ['http://localhost:9000/oauth2/callback'],
        });
        const t = Template.fromStack(stack);
        const customResources = t.findResources('Custom::OAuthCompleteRegisterReturnUrls');
        const stringified = JSON.stringify(customResources);
        expect(stringified).toContain('http://localhost:9000/oauth2/callback');
        expect(stringified).not.toContain('http://localhost:33424/oauth2/callback');
    });
});

describe('OAuthCompleteSessionApi — exposed attributes', () => {
    it('completeSessionUrl ends with /complete-session and references the API stage', () => {
        const { stack, auth } = stackWithCognitoAuth('UrlAttrCase');
        const api = new OAuthCompleteSessionApi(stack, 'OAuthComplete', {
            identityProvider: auth,
            gatewayId: FAKE_GATEWAY_ID,
        });
        // Token-y string at synth time — we just confirm the suffix.
        expect(api.completeSessionUrl.endsWith('complete-session')).toBe(true);
    });
});
