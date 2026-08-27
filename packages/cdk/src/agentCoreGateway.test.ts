/**
 * Snapshot + targeted assertion tests for `AgentCoreGateway`.
 *
 * Snapshots lock the synthesized CloudFormation against accidental
 * change; targeted `hasResourceProperties` assertions document the
 * intent (Cognito short-circuit vs custom-JWT wiring, the azp
 * custom-claim translation, target factories still work via the
 * inherited L2 instance methods).
 */

import { aws_bedrockagentcore as agentcore } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { AgentCoreGateway } from './agentCoreGateway.js';
import {
    freshStack,
    stackWithCognitoAuth,
    stackWithEntraIdp,
} from './testFixtures.js';
import { externalOidc } from './identity/identityProvider.js';

function synthGatewayCognito() {
    const { stack, auth } = stackWithCognitoAuth();
    new AgentCoreGateway(stack, 'Gateway', {
        identityProvider: auth,
        gatewayName: 'mcp-savvy-test-gw',
        description: 'snapshot fixture',
    });
    return Template.fromStack(stack);
}

function synthGatewayEntra() {
    const { stack, idp } = stackWithEntraIdp();
    new AgentCoreGateway(stack, 'Gateway', {
        identityProvider: idp,
        gatewayName: 'mcp-savvy-test-gw-entra',
    });
    return Template.fromStack(stack);
}

describe('AgentCoreGateway — snapshot', () => {
    it('matches the synthesized template (Cognito IdP)', () => {
        expect(synthGatewayCognito().toJSON()).toMatchSnapshot();
    });

    it('matches the synthesized template (external OIDC IdP with azp claim)', () => {
        expect(synthGatewayEntra().toJSON()).toMatchSnapshot();
    });
});

describe('AgentCoreGateway — defaults', () => {
    it('creates exactly one gateway resource', () => {
        synthGatewayCognito().resourceCountIs('AWS::BedrockAgentCore::Gateway', 1);
    });

    it('honors the gatewayName override', () => {
        synthGatewayCognito().hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
            Name: 'mcp-savvy-test-gw',
        });
    });

    it('uses MCP as the protocol type by default', () => {
        synthGatewayCognito().hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
            ProtocolType: 'MCP',
        });
    });

    it('conditions every AgentCore service trust statement', () => {
        const roles = synthGatewayCognito().findResources('AWS::IAM::Role');
        const statements = Object.values(roles).flatMap((role) => {
            const document = (role as { Properties?: { AssumeRolePolicyDocument?: { Statement?: unknown[] } } })
                .Properties?.AssumeRolePolicyDocument;
            return document?.Statement ?? [];
        });
        const trusts = statements.filter((statement) =>
            JSON.stringify(statement).includes('bedrock-agentcore.amazonaws.com'),
        ) as Array<{ Condition?: { StringEquals?: unknown; ArnLike?: unknown } }>;
        expect(trusts).toHaveLength(1);
        expect(trusts[0]?.Condition?.StringEquals).toBeDefined();
        expect(trusts[0]?.Condition?.ArnLike).toBeDefined();
    });
});

describe('AgentCoreGateway — Cognito authorizer wiring', () => {
    it('configures CUSTOM_JWT with the Cognito issuer + AllowedClients', () => {
        synthGatewayCognito().hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
            AuthorizerType: 'CUSTOM_JWT',
            AuthorizerConfiguration: {
                CustomJWTAuthorizer: Match.objectLike({
                    DiscoveryUrl: Match.anyValue(),
                    AllowedClients: Match.anyValue(),
                }),
            },
        });
    });

    it('does NOT inject an azp custom claim for the Cognito branch', () => {
        const json = synthGatewayCognito().toJSON();
        const gateways = Object.values(json.Resources as Record<string, { Type: string; Properties: { AuthorizerConfiguration?: { CustomJWTAuthorizer?: { CustomClaims?: unknown[] } } } }>)
            .filter((r) => r.Type === 'AWS::BedrockAgentCore::Gateway');
        expect(gateways).toHaveLength(1);
        const auth = gateways[0]?.Properties.AuthorizerConfiguration?.CustomJWTAuthorizer;
        expect(auth?.CustomClaims).toBeUndefined();
    });
});

describe('AgentCoreGateway — external OIDC authorizer wiring', () => {
    it('configures CUSTOM_JWT pointed at the external discovery URL', () => {
        synthGatewayEntra().hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
            AuthorizerType: 'CUSTOM_JWT',
            AuthorizerConfiguration: {
                CustomJWTAuthorizer: Match.objectLike({
                    DiscoveryUrl:
                        'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0/.well-known/openid-configuration',
                    AllowedAudience: ['11111111-1111-1111-1111-111111111111'],
                }),
            },
        });
    });

    it('translates a customClaim into a string-equals rule on the named claim', () => {
        synthGatewayEntra().hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
            AuthorizerConfiguration: {
                CustomJWTAuthorizer: {
                    CustomClaims: [
                        {
                            InboundTokenClaimName: 'azp',
                            InboundTokenClaimValueType: 'STRING',
                            AuthorizingClaimMatchValue: {
                                ClaimMatchOperator: 'EQUALS',
                                ClaimMatchValue: {
                                    MatchValueString: '11111111-1111-1111-1111-111111111111',
                                },
                            },
                        },
                    ],
                },
            },
        });
    });

    it('does NOT set AllowedClients for an external IdP that uses azp', () => {
        const json = synthGatewayEntra().toJSON();
        const gateways = Object.values(json.Resources as Record<string, { Type: string; Properties: { AuthorizerConfiguration?: { CustomJWTAuthorizer?: { AllowedClients?: unknown } } } }>)
            .filter((r) => r.Type === 'AWS::BedrockAgentCore::Gateway');
        expect(gateways).toHaveLength(1);
        const auth = gateways[0]?.Properties.AuthorizerConfiguration?.CustomJWTAuthorizer;
        expect(auth?.AllowedClients).toBeUndefined();
    });
});

describe('AgentCoreGateway — inheritance contract', () => {
    it('is an instance of the L2 agentcore.Gateway (target factories inherited)', () => {
        const stack = freshStack('InheritanceCase');
        const idp = externalOidc({
            issuer: 'https://example.com/',
            allowedAudience: ['mcp-savvy-test'],
        });
        const gw = new AgentCoreGateway(stack, 'Gateway', {
            identityProvider: idp,
            gatewayName: 'mcp-savvy-target-test',
        });
        expect(gw).toBeInstanceOf(agentcore.Gateway);
        // Inherited target factories are present on the prototype chain.
        expect(typeof gw.addLambdaTarget).toBe('function');
        expect(typeof gw.addOpenApiTarget).toBe('function');
        expect(typeof gw.addSmithyTarget).toBe('function');
        expect(typeof gw.addMcpServerTarget).toBe('function');
        expect(typeof gw.addApiGatewayTarget).toBe('function');
    });
});
