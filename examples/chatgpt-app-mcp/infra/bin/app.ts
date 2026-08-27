#!/usr/bin/env node
/**
 * CDK app entrypoint for the mcp-savvy chatgpt-app-mcp demo.
 *
 * Four-stack topology (Pattern D — see DEPLOYMENT-PATTERNS.md):
 *
 *   McpSavvyChatGptAppData     — four DynamoDB tables (customer_data,
 *                                secure_view_refs, audit_log, branches) +
 *                                seed Lambda custom resource.
 *   McpSavvyChatGptAppCognito  — user pool + Hosted UI + PKCE
 *                                client; MFA TOTP required. Resource
 *                                server identifier = the public URL.
 *   McpSavvyChatGptAppNetwork  — VPC + private-isolated subnets +
 *                                logs interface VPCE + DynamoDB GW
 *                                endpoint + Lambda SG. Lambda runs
 *                                in the VPC to mirror a real banking
 *                                deployment where the same function
 *                                would be querying private RDS /
 *                                Aurora / internal services.
 *   McpSavvyChatGptAppApp      — Lambda (in VPC) + Public REST API +
 *                                Cognito User Pool Authorizer +
 *                                Request Validator + WAF + custom
 *                                domain + Route 53 alias.
 *
 * Required env vars (read on synth/deploy):
 *
 *   MCP_SAVVY_CHATGPT_APP_DOMAIN          required FQDN; API Gateway custom domain
 *   MCP_SAVVY_CHATGPT_APP_CERT_ARN        required ACM cert ARN (same region as API Gateway)
 *   MCP_SAVVY_CHATGPT_APP_HOSTED_ZONE_ID  optional Route 53 zone ID
 *   MCP_SAVVY_CHATGPT_APP_HOSTED_ZONE_NAME  required when HOSTED_ZONE_ID is set
 *   MCP_SAVVY_CHATGPT_APP_AZ_COUNT        optional (default 2)
 *
 * If DOMAIN/CERT_ARN are not set, only the Data stack synthesises —
 * useful for early-stage local synth checks.
 */

import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AppStack } from '../lib/app-stack/index.js';
import { CognitoStack } from '../lib/cognito-stack.js';
import { DataStack } from '../lib/data-stack.js';
import { NetworkStack } from '../lib/network-stack.js';

const app = new cdk.App();

const env: cdk.Environment = {
    account: process.env['CDK_DEFAULT_ACCOUNT'],
    region: process.env['CDK_DEFAULT_REGION'] ?? 'us-east-1',
};

const idp = (process.env['MCP_SAVVY_DEMO_IDP'] ?? 'cognito').toLowerCase();
if (idp !== 'cognito') {
    throw new Error(
        `MCP_SAVVY_DEMO_IDP=${idp} not yet supported by chatgpt-app-mcp. ` +
        'Only the cognito branch is currently wired for this example.',
    );
}

const domainPrefix =
    process.env['MCP_SAVVY_CHATGPT_APP_DOMAIN_PREFIX'] ?? 'mcp-savvy-chatgpt-app';

const dataStack = new DataStack(app, 'McpSavvyChatGptAppData', { env });

const domain = process.env['MCP_SAVVY_CHATGPT_APP_DOMAIN'];
const certArn = process.env['MCP_SAVVY_CHATGPT_APP_CERT_ARN'];
const hostedZoneId = process.env['MCP_SAVVY_CHATGPT_APP_HOSTED_ZONE_ID'];
const hostedZoneName = process.env['MCP_SAVVY_CHATGPT_APP_HOSTED_ZONE_NAME'];
const azCount = process.env['MCP_SAVVY_CHATGPT_APP_AZ_COUNT']
    ? Number(process.env['MCP_SAVVY_CHATGPT_APP_AZ_COUNT'])
    : 2;

if (domain && certArn) {
    const publicUrl = `https://${domain}`;
    const cognitoStack = new CognitoStack(app, 'McpSavvyChatGptAppCognito', {
        env,
        domainPrefix,
        // Cognito's resource server identifier (RFC 8707 binding) is
        // the public URL of the protected resource. Literal string —
        // no cross-stack token, no cycles.
        resourceIdentifier: publicUrl,
    });
    const networkStack = new NetworkStack(app, 'McpSavvyChatGptAppNetwork', {
        env,
        azCount,
    });
    new AppStack(app, 'McpSavvyChatGptAppApp', {
        env,
        vpc: networkStack.vpc,
        lambdaSecurityGroup: networkStack.lambdaSecurityGroup,
        domain,
        publicUrl,
        certificateArn: certArn,
        ...(hostedZoneId ? { hostedZoneId } : {}),
        ...(hostedZoneName ? { hostedZoneName } : {}),
        cognitoUserPool: cognitoStack.auth.userPool,
        cognitoIssuerUrl: cognitoStack.auth.issuerUrl,
        cognitoHostedUiUrl: cognitoStack.auth.hostedUiUrl,
        customerDataTable: dataStack.customerDataTable,
        secureViewRefsTable: dataStack.secureViewRefsTable,
        auditLogTable: dataStack.auditLogTable,
        branchesTable: dataStack.branchesTable,
        requiredScope: cognitoStack.balanceReadScopeFull,
    });
} else if (domain || certArn) {
    throw new Error(
        'MCP_SAVVY_CHATGPT_APP_DOMAIN and MCP_SAVVY_CHATGPT_APP_CERT_ARN must be set ' +
        'together. See .env.example for a template.',
    );
}

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
