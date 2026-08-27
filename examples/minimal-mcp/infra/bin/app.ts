#!/usr/bin/env node
/**
 * CDK app entrypoint for the mcp-savvy minimal-mcp demo.
 *
 * Three deployments, controlled by `MCP_SAVVY_DEMO_IDP`:
 *
 *   cognito (default)              greenfield Cognito user pool
 *     - McpSavvyDemoCognito         (provisions pool + clients + Hosted UI)
 *     - McpSavvyDemoRuntime         (AgentCore Runtime gated by Cognito JWT)
 *
 *   imported-cognito               existing Cognito pool you operate
 *     - McpSavvyDemoRuntime only    (no Cognito stack — points at the
 *                                    pool referenced by the
 *                                    MCP_SAVVY_SHARED_* env vars)
 *
 *   entra                          Microsoft Entra ID v2 tenant
 *     - McpSavvyDemoEntraRuntime    (no AWS-side IdP; Entra is the
 *                                    issuer; bound by `azp` not
 *                                    `client_id` per the v2 quirk)
 *
 * Synthesis is checked by cdk-nag (AwsSolutionsChecks) so policy
 * issues fail the build before they fail the deploy.
 */

import * as cdk from 'aws-cdk-lib';
import { entraExternalOidc, importCognito } from '@mcp-savvy/cdk';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CognitoStack } from '../lib/cognito-stack.js';
import { RuntimeStack } from '../lib/runtime-stack.js';

const app = new cdk.App();

const env: cdk.Environment = {
    account: process.env['CDK_DEFAULT_ACCOUNT'],
    region: process.env['CDK_DEFAULT_REGION'] ?? 'us-east-1',
};

const idp = (process.env['MCP_SAVVY_DEMO_IDP'] ?? 'cognito').toLowerCase();

if (idp === 'cognito') {
    const domainPrefix =
        process.env['MCP_SAVVY_DEMO_DOMAIN_PREFIX'] ?? 'mcp-savvy-demo';

    // MFA defaults to REQUIRED (TOTP-only). Pass MCP_SAVVY_DEMO_MFA=off
    // to relax to OPTIONAL for demos where forcing TOTP enrollment is
    // unwelcome — every other deployment should leave this unset.
    const mfaRequired =
        (process.env['MCP_SAVVY_DEMO_MFA'] ?? 'on').toLowerCase() !== 'off';

    const cognito = new CognitoStack(app, 'McpSavvyDemoCognito', {
        env,
        domainPrefix,
        mfaRequired,
    });

    new RuntimeStack(app, 'McpSavvyDemoRuntime', {
        env,
        identityProvider: cognito.auth,
    });
} else if (idp === 'imported-cognito') {
    const sharedPoolId = process.env['MCP_SAVVY_SHARED_POOL_ID'];
    const sharedClientId = process.env['MCP_SAVVY_SHARED_CLIENT_ID'];
    const sharedHostedUi = process.env['MCP_SAVVY_SHARED_HOSTED_UI'];
    if (!sharedPoolId || !sharedClientId || !sharedHostedUi) {
        throw new Error(
            'MCP_SAVVY_DEMO_IDP=imported-cognito requires MCP_SAVVY_SHARED_POOL_ID, ' +
            'MCP_SAVVY_SHARED_CLIENT_ID, and MCP_SAVVY_SHARED_HOSTED_UI. See README.',
        );
    }
    new RuntimeStack(app, 'McpSavvyDemoRuntime', {
        env,
        identityProvider: (scope) =>
            importCognito(scope, 'SharedAuth', {
                userPoolId: sharedPoolId,
                humanClientId: sharedClientId,
                hostedUiUrl: sharedHostedUi,
            }),
    });
} else if (idp === 'entra') {
    const tenantId = process.env['ENTRA_TENANT_ID'];
    const clientId = process.env['ENTRA_CLIENT_ID'];
    if (!tenantId || !clientId) {
        throw new Error(
            'MCP_SAVVY_DEMO_IDP=entra requires ENTRA_TENANT_ID and ENTRA_CLIENT_ID. ' +
            'See .env.example.',
        );
    }
    const entraOpts: { tenantId: string; clientId: string; audience?: string } = {
        tenantId,
        clientId,
    };
    if (process.env['ENTRA_AUDIENCE']) entraOpts.audience = process.env['ENTRA_AUDIENCE'];
    new RuntimeStack(app, 'McpSavvyDemoEntraRuntime', {
        env,
        runtimeName: 'mcp_savvy_demo_entra',
        identityProvider: entraExternalOidc(entraOpts),
    });
} else {
    throw new Error(
        `MCP_SAVVY_DEMO_IDP=${idp} not supported. ` +
        'Use one of: cognito (default), imported-cognito, entra.',
    );
}

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
