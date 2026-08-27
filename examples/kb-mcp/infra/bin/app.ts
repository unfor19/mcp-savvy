#!/usr/bin/env node
/**
 * CDK app entrypoint for the mcp-savvy kb-mcp demo.
 *
 * Three stacks (single-flavor — agentic Strands agent over the KB):
 *   - McpSavvyKbDemoCognito   — Cognito user pool (skipped if
 *                               MCP_SAVVY_DEMO_IDP=imported-cognito)
 *   - McpSavvyKbDemoKb        — Bedrock Knowledge Base over S3 Vectors
 *   - McpSavvyKbDemoRuntime   — AgentCore Runtime running the
 *                               agent in `agents/agentic/`
 *
 * For the no-LLM-in-the-loop variant (Lambda calling Bedrock Agent
 * Runtime directly, no AgentCore Runtime), see `examples/gateway-kb-mcp`.
 *
 * IdP follows the same `MCP_SAVVY_DEMO_IDP={cognito,imported-cognito,entra}`
 * contract as the other examples — see `examples/minimal-mcp` README
 * for the env-var details.
 *
 * Synthesis is checked by cdk-nag (AwsSolutionsChecks).
 */

import * as cdk from 'aws-cdk-lib';
import { entraExternalOidc, importCognito } from '@mcp-savvy/cdk';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CognitoStack } from '../lib/cognito-stack.js';
import { KbStack } from '../lib/kb-stack.js';
import { RuntimeStack } from '../lib/runtime-stack.js';

const app = new cdk.App();

const env: cdk.Environment = {
    account: process.env['CDK_DEFAULT_ACCOUNT'],
    region: process.env['CDK_DEFAULT_REGION'] ?? 'us-east-1',
};

const idp = (process.env['MCP_SAVVY_DEMO_IDP'] ?? 'cognito').toLowerCase();

// KB stack is shared across IdP variants.
const kb = new KbStack(app, 'McpSavvyKbDemoKb', { env });

if (idp === 'cognito') {
    const domainPrefix =
        process.env['MCP_SAVVY_DEMO_DOMAIN_PREFIX'] ?? 'mcp-savvy-kb-demo';
    const mfaRequired =
        (process.env['MCP_SAVVY_DEMO_MFA'] ?? 'on').toLowerCase() !== 'off';

    const cognito = new CognitoStack(app, 'McpSavvyKbDemoCognito', {
        env,
        domainPrefix,
        mfaRequired,
    });

    new RuntimeStack(app, 'McpSavvyKbDemoRuntime', {
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
    new RuntimeStack(app, 'McpSavvyKbDemoRuntime', {
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
    new RuntimeStack(app, 'McpSavvyKbDemoEntraRuntime', {
        env,
        identityProvider: entraExternalOidc(entraOpts),
        knowledgeBaseId: kb.kb.knowledgeBaseId,
        knowledgeBaseArn: kb.kb.knowledgeBaseArn,
        runtimeName: 'mcp_savvy_kb_demo_entra',
    });
} else {
    throw new Error(
        `MCP_SAVVY_DEMO_IDP=${idp} not supported. ` +
        'Use one of: cognito (default), imported-cognito, entra.',
    );
}

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
