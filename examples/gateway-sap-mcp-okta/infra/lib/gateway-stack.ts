/** Okta-gated AgentCore Gateway stack for the AWS for SAP MCP target. */

import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { AgentCoreGateway, type IdentityProvider } from '@mcp-savvy/cdk';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';

/** Inputs for the Okta-to-SAP MCP Gateway stack. */
export interface GatewayStackProps extends cdk.StackProps {
    /** Okta identity provider that gates the public Gateway endpoint. */
    readonly identityProvider: IdentityProvider;
    /** Existing encoded AWS for SAP MCP Runtime invocation URL. */
    readonly sapMcpEndpoint: string;
    /** Existing AgentCore Identity Cognito OAuth provider ARN. */
    readonly sapMcpProviderArn: string;
    /** Exact managed secret ARN returned with the OAuth provider. */
    readonly sapMcpSecretArn: string;
    /** Cognito resource-server scopes requested for the SAP MCP target. */
    readonly sapMcpScopes: string[];
    /** Gateway name override. */
    readonly gatewayName?: string;
    /** MCP target name and host-visible tool prefix override. */
    readonly targetName?: string;
}

/** Deploys an Okta-gated Gateway with AWS for SAP MCP as a native target. */
export class GatewayStack extends cdk.Stack {
    /** Gateway exposed to mcp-savvy clients. */
    public readonly gateway: AgentCoreGateway;

    constructor(scope: Construct, id: string, props: GatewayStackProps) {
        super(scope, id, props);

        const targetName = props.targetName ?? 'sap';
        this.gateway = new AgentCoreGateway(this, 'Gateway', {
            identityProvider: props.identityProvider,
            gatewayName: props.gatewayName ?? 'mcp-savvy-sap-okta',
            description: 'Okta-gated Gateway for an AWS for SAP MCP Server target.',
            protocolConfiguration: new agentcore.McpProtocolConfiguration({
                supportedVersions: [
                    agentcore.MCPProtocolVersion.of('2025-06-18'),
                    agentcore.MCPProtocolVersion.of('2025-11-25'),
                ],
                searchType: agentcore.McpGatewaySearchType.SEMANTIC,
            }),
        });

        const target = this.gateway.addMcpServerTarget('SapMcpTarget', {
            gatewayTargetName: targetName,
            description: 'Read-only AWS for SAP MCP Server on AgentCore Runtime.',
            endpoint: props.sapMcpEndpoint,
            credentialProviderConfigurations: [
                new agentcore.OAuthCredentialProviderConfiguration({
                    providerArn: props.sapMcpProviderArn,
                    secretArn: props.sapMcpSecretArn,
                    scopes: props.sapMcpScopes,
                }),
            ],
        });

        // OAuthCredentialProviderConfiguration in CDK 2.267.0 does not expose
        // grantType. Pin the supported service-identity contract explicitly;
        // omission is not documented as a stable CLIENT_CREDENTIALS default.
        // https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-building-adding-targets-authorization.html
        const cfnTarget = target.node.defaultChild as agentcore.CfnGatewayTarget;
        cfnTarget.addPropertyOverride(
            'CredentialProviderConfigurations.0.CredentialProvider.OauthCredentialProvider.GrantType',
            'CLIENT_CREDENTIALS',
        );

        new cdk.CfnOutput(this, 'GatewayId', {
            value: this.gateway.gatewayId,
            description: 'AgentCore Gateway ID',
        });
        new cdk.CfnOutput(this, 'GatewayUrl', {
            value: this.gateway.gatewayUrl ?? '<resolved-at-deploy-time>',
            description: 'AgentCore Gateway URL for MCP_SAVVY_REMOTE_URL',
        });
        new cdk.CfnOutput(this, 'TargetName', {
            value: targetName,
            description: `SAP MCP target prefix; tools surface as ${targetName}___*`,
        });

        cdk.Tags.of(this).add('Project', 'mcp-savvy-sap-okta');

        NagSuppressions.addResourceSuppressions(
            this.gateway,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason:
                        'The AgentCore L2 scopes workload identity access to this Gateway ' +
                        'name with its required deployment-time suffix wildcard.',
                },
            ],
            true,
        );
    }
}
