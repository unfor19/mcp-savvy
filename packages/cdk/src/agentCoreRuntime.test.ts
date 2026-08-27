/**
 * Snapshot + targeted assertion tests for `AgentCoreRuntime`.
 *
 * Snapshots lock the synthesized CloudFormation against accidental
 * change; targeted `hasResourceProperties` assertions document the
 * intent (MCP protocol, JWT vs Cognito authorizer config, X-Ray on,
 * the cdk-nag IAM5 suppression, the azp custom-claim translation).
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aws_bedrockagentcore as agentcore } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { AgentCoreRuntime } from './agentCoreRuntime.js';
import { externalOidc } from './identity/identityProvider.js';
import {
    freshStack,
    stackWithCognitoAuth,
    stackWithEntraIdp,
} from './testFixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Reuse the example's agent Dockerfile directory as a stable asset
// source — synthesis only needs the directory to exist; the Docker
// build doesn't actually run during synth.
const AGENT_DIR = path.resolve(HERE, '..', '..', '..', 'examples', 'minimal-mcp', 'agent');

function fromAsset(): agentcore.AgentRuntimeArtifact {
    return agentcore.AgentRuntimeArtifact.fromAsset(AGENT_DIR);
}

function synthRuntimeCognito() {
    const { stack, auth } = stackWithCognitoAuth();
    new AgentCoreRuntime(stack, 'Runtime', {
        identityProvider: auth,
        agentRuntimeArtifact: fromAsset(),
        runtimeName: 'mcp_savvy_test',
        description: 'snapshot fixture',
    });
    return Template.fromStack(stack);
}

function synthRuntimeEntra() {
    const { stack, idp } = stackWithEntraIdp();
    new AgentCoreRuntime(stack, 'Runtime', {
        identityProvider: idp,
        agentRuntimeArtifact: fromAsset(),
        runtimeName: 'mcp_savvy_test_entra',
    });
    return Template.fromStack(stack);
}

describe('AgentCoreRuntime — snapshot', () => {
    it('matches the synthesized template (Cognito IdP)', () => {
        expect(synthRuntimeCognito().toJSON()).toMatchSnapshot();
    });

    it('matches the synthesized template (external OIDC IdP with azp claim)', () => {
        expect(synthRuntimeEntra().toJSON()).toMatchSnapshot();
    });
});

describe('AgentCoreRuntime — defaults', () => {
    it('creates exactly one runtime resource', () => {
        synthRuntimeCognito().resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);
    });

    it('defaults to MCP protocol', () => {
        synthRuntimeCognito().hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
            ProtocolConfiguration: 'MCP',
        });
    });

    it('honors the runtimeName override', () => {
        synthRuntimeCognito().hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
            AgentRuntimeName: 'mcp_savvy_test',
        });
    });

    it('enables X-Ray tracing by default (Logs::Delivery wired to XRAY)', () => {
        const t = synthRuntimeCognito();
        t.hasResourceProperties('AWS::Logs::DeliveryDestination', {
            DeliveryDestinationType: 'XRAY',
        });
        t.resourceCountIs('AWS::Logs::Delivery', 1);
    });

    it('suppresses cdk-nag IAM5 on the runtime', () => {
        // The L2 attaches cdk_nag metadata on each contained resource;
        // we assert the suppression body contains AwsSolutions-IAM5.
        const t = synthRuntimeCognito();
        const stringified = JSON.stringify(t.toJSON());
        expect(stringified).toContain('AwsSolutions-IAM5');
        expect(stringified).toContain('AgentCore Runtime auto-managed execution role');
    });
});

describe('AgentCoreRuntime — Cognito authorizer wiring', () => {
    it('configures a JWT authorizer with AllowedClients (Cognito branch)', () => {
        synthRuntimeCognito().hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
            AuthorizerConfiguration: {
                CustomJWTAuthorizer: Match.objectLike({
                    DiscoveryUrl: Match.anyValue(),
                    AllowedClients: Match.anyValue(),
                }),
            },
        });
    });

    it('does NOT inject an azp custom claim for the Cognito branch', () => {
        const json = synthRuntimeCognito().toJSON();
        const runtimes = Object.values(json.Resources as Record<string, { Type: string; Properties: { AuthorizerConfiguration?: { CustomJWTAuthorizer?: { CustomClaims?: unknown[] } } } }>)
            .filter((r) => r.Type === 'AWS::BedrockAgentCore::Runtime');
        expect(runtimes).toHaveLength(1);
        const auth = runtimes[0]?.Properties.AuthorizerConfiguration?.CustomJWTAuthorizer;
        expect(auth?.CustomClaims).toBeUndefined();
    });
});

describe('AgentCoreRuntime — external OIDC authorizer wiring', () => {
    it('configures a JWT authorizer pointed at the external discovery URL', () => {
        synthRuntimeEntra().hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
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
        synthRuntimeEntra().hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
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
        const json = synthRuntimeEntra().toJSON();
        const runtimes = Object.values(json.Resources as Record<string, { Type: string; Properties: { AuthorizerConfiguration?: { CustomJWTAuthorizer?: { AllowedClients?: unknown } } } }>)
            .filter((r) => r.Type === 'AWS::BedrockAgentCore::Runtime');
        expect(runtimes).toHaveLength(1);
        const auth = runtimes[0]?.Properties.AuthorizerConfiguration?.CustomJWTAuthorizer;
        expect(auth?.AllowedClients).toBeUndefined();
    });
});

describe('AgentCoreRuntime — option overrides', () => {
    it('disables tracing when tracingEnabled: false (no XRAY delivery)', () => {
        const stack = freshStack('NoTracingCase');
        const idp = externalOidc({
            issuer: 'https://example.com/',
            allowedAudience: ['aud1'],
        });
        new AgentCoreRuntime(stack, 'Runtime', {
            identityProvider: idp,
            agentRuntimeArtifact: fromAsset(),
            runtimeName: 'no_trace',
            tracingEnabled: false,
        });
        const t = Template.fromStack(stack);
        // No XRAY delivery destination should be synthesized.
        const dests = t.findResources('AWS::Logs::DeliveryDestination', {
            Properties: { DeliveryDestinationType: 'XRAY' },
        });
        expect(Object.keys(dests)).toHaveLength(0);
    });

    it('honors a non-MCP protocol override', () => {
        const stack = freshStack('HttpProtoCase');
        const idp = externalOidc({
            issuer: 'https://example.com/',
            allowedAudience: ['mcp-api'],
        });
        new AgentCoreRuntime(stack, 'Runtime', {
            identityProvider: idp,
            agentRuntimeArtifact: fromAsset(),
            runtimeName: 'http_proto',
            protocolConfiguration: agentcore.ProtocolType.HTTP,
        });
        Template.fromStack(stack).hasResourceProperties(
            'AWS::BedrockAgentCore::Runtime',
            { ProtocolConfiguration: 'HTTP' },
        );
    });
});
