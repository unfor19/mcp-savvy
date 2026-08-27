#!/usr/bin/env node
/**
 * CDK app entrypoint for the mcp-savvy gateway-3lo-mcp demo.
 *
 * One deployable today (greenfield Cognito):
 *
 *   - McpSavvy3loDemoCognito  Cognito user pool + clients + Hosted UI.
 *   - McpSavvy3loDemoGateway  AgentCore Gateway with a GitHub OpenAPI
 *                             target gated by Cognito JWT, plus an
 *                             `OAuthCompleteSessionApi` for the 3LO
 *                             second-leg flow.
 *
 * Imported-Cognito and Entra paths can be added later in the same
 * shape as `examples/gateway-lambda-mcp/infra/bin/app.ts`.
 *
 * Required env vars:
 *
 *   MCP_SAVVY_GITHUB_OAUTH_PROVIDER_ARN
 *     ARN of the AgentCore Identity OAuth2 credential provider for
 *     GitHub. Configure once via the AWS console / CLI; reuse across
 *     gateways. Format:
 *       arn:aws:bedrock-agentcore:<region>:<account>:token-vault/default/oauth2credentialprovider/<name>
 *
 * Synthesis is checked by cdk-nag (AwsSolutionsChecks) so policy
 * issues fail the build before they fail the deploy.
 */

import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CognitoStack } from '../lib/cognito-stack.js';
import { GatewayStack } from '../lib/gateway-stack.js';

const app = new cdk.App();

const env: cdk.Environment = {
    account: process.env['CDK_DEFAULT_ACCOUNT'],
    region: process.env['CDK_DEFAULT_REGION'] ?? 'us-east-1',
};

const githubProviderArn = process.env['MCP_SAVVY_GITHUB_OAUTH_PROVIDER_ARN'];
if (!githubProviderArn) {
    throw new Error(
        'MCP_SAVVY_GITHUB_OAUTH_PROVIDER_ARN is required. Configure a GitHub ' +
        'OAuth2 credential provider in AgentCore Identity (one-off) and pass ' +
        'its ARN. See examples/gateway-3lo-mcp/README.md.',
    );
}

const idp = (process.env['MCP_SAVVY_DEMO_IDP'] ?? 'cognito').toLowerCase();

if (idp === 'cognito') {
    const domainPrefix =
        process.env['MCP_SAVVY_3LO_DEMO_DOMAIN_PREFIX'] ?? 'mcp-savvy-3lo-demo';

    // MFA defaults to REQUIRED (TOTP-only). Pass MCP_SAVVY_3LO_DEMO_MFA=off
    // to relax to OPTIONAL for first-run demos where forcing TOTP
    // enrollment is unwelcome.
    const mfaRequired =
        (process.env['MCP_SAVVY_3LO_DEMO_MFA'] ?? 'on').toLowerCase() !== 'off';

    const cognito = new CognitoStack(app, 'McpSavvy3loDemoCognito', {
        env,
        domainPrefix,
        mfaRequired,
    });

    new GatewayStack(app, 'McpSavvy3loDemoGateway', {
        env,
        identityProvider: cognito.auth,
        githubCredentialProviderArn: githubProviderArn,
    });
} else {
    throw new Error(
        `MCP_SAVVY_DEMO_IDP=${idp} not supported by gateway-3lo-mcp yet. ` +
        'Use cognito (default). Imported-Cognito and Entra paths land later.',
    );
}

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
