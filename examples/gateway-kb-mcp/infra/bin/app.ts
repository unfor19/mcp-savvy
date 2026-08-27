#!/usr/bin/env node
/**
 * CDK app entrypoint for the mcp-savvy gateway-kb-mcp demo.
 *
 * The "no-LLM-in-the-loop" KB variant: an AgentCore Gateway fronts
 * a Lambda target that forwards `kb_retrieve` and
 * `kb_retrieve_and_generate` straight to bedrock-agent-runtime. The
 * host LLM drives RAG. For the agentic variant (a Strands agent that
 * grounds answers itself, exposing a single `ask`), see
 * `examples/kb-mcp`.
 *
 * Three stacks (Cognito skipped for imported-cognito / entra):
 *   - McpSavvyGatewayKbDemoCognito  — Cognito user pool
 *   - McpSavvyGatewayKbDemoKb       — Bedrock KB over S3 Vectors
 *   - McpSavvyGatewayKbDemoGateway  — Gateway + Lambda KB target
 *
 * Same `MCP_SAVVY_DEMO_IDP={cognito,imported-cognito,entra}`
 * contract as the other examples. cdk-nag checked on synth.
 */

import * as cdk from 'aws-cdk-lib';
import { entraExternalOidc, importCognito } from '@mcp-savvy/cdk';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CognitoStack } from '../lib/cognito-stack.js';
import { KbStack } from '../lib/kb-stack.js';
import { GatewayStack } from '../lib/gateway-stack.js';

const app = new cdk.App();

const env: cdk.Environment = {
    account: process.env['CDK_DEFAULT_ACCOUNT'],
    region: process.env['CDK_DEFAULT_REGION'] ?? 'us-east-1',
};

const idp = (process.env['MCP_SAVVY_DEMO_IDP'] ?? 'cognito').toLowerCase();

// KB stack is shared across IdP variants.
const kb = new KbStack(app, 'McpSavvyGatewayKbDemoKb', { env });

if (idp === 'cognito') {
    const domainPrefix =
        process.env['MCP_SAVVY_DEMO_DOMAIN_PREFIX'] ?? 'mcp-savvy-gw-kb-demo';
    const mfaRequired =
        (process.env['MCP_SAVVY_DEMO_MFA'] ?? 'on').toLowerCase() !== 'off';

    const cognito = new CognitoStack(app, 'McpSavvyGatewayKbDemoCognito', {
        env,
        domainPrefix,
        mfaRequired,
    });

    new GatewayStack(app, 'McpSavvyGatewayKbDemoGateway', {
        env,
        identityProvider: cognito.auth,
        knowledgeBaseId: kb.kb.knowledgeBaseId,
        knowledgeBaseArn: kb.kb.knowledgeBaseArn,
    });
} else if (idp === 'imported-cognito') {
    const sharedPoolId = process.env['MCP_SAVVY_SHARED_POOL_ID'];
    const sharedClientId = process.env['MCP_SAVVY_SHARED_CLIENT_ID'];
    const sharedHostedUi = process.env['MCP_SAVVY_SHARED_HOSTED_UI'];
    if (!sharedPoolId || !sharedClientId || !sharedHostedUi) {
        throw new Error(
            'MCP_SAVVY_DEMO_IDP=imported-cognito requires MCP_SAVVY_SHARED_POOL_ID, ' +
            'MCP_SAVVY_SHARED_CLIENT_ID, and MCP_SAVVY_SHARED_HOSTED_UI.',
        );
    }
    new GatewayStack(app, 'McpSavvyGatewayKbDemoGateway', {
        env,
        identityProvider: (scope) =>
            importCognito(scope, 'SharedAuth', {
                userPoolId: sharedPoolId,
                humanClientId: sharedClientId,
                hostedUiUrl: sharedHostedUi,
            }),
        knowledgeBaseId: kb.kb.knowledgeBaseId,
        knowledgeBaseArn: kb.kb.knowledgeBaseArn,
    });
} else if (idp === 'entra') {
    const tenantId = process.env['ENTRA_TENANT_ID'];
    const clientId = process.env['ENTRA_CLIENT_ID'];
    if (!tenantId || !clientId) {
        throw new Error(
            'MCP_SAVVY_DEMO_IDP=entra requires ENTRA_TENANT_ID and ENTRA_CLIENT_ID.',
        );
    }
    const entraOpts: { tenantId: string; clientId: string; audience?: string } = {
        tenantId,
        clientId,
    };
    if (process.env['ENTRA_AUDIENCE']) entraOpts.audience = process.env['ENTRA_AUDIENCE'];
    new GatewayStack(app, 'McpSavvyGatewayKbDemoEntraGateway', {
        env,
        identityProvider: entraExternalOidc(entraOpts),
        knowledgeBaseId: kb.kb.knowledgeBaseId,
        knowledgeBaseArn: kb.kb.knowledgeBaseArn,
        gatewayName: 'mcp-savvy-gw-kb-demo-entra',
    });
} else {
    throw new Error(
        `MCP_SAVVY_DEMO_IDP=${idp} not supported. ` +
        'Use one of: cognito (default), imported-cognito, entra.',
    );
}

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
