#!/usr/bin/env node
/**
 * CDK entrypoint for the Okta-gated AWS for SAP MCP Gateway demo.
 *
 * Required operator values are deliberately non-secret: an existing SAP MCP
 * Runtime endpoint and AgentCore Identity OAuth provider/secret ARNs. AgentCore
 * keeps the Cognito client secret value in its managed Secrets Manager entry.
 */

import * as cdk from 'aws-cdk-lib';
import { oktaExternalOidc, type OktaOidcOptions } from '@mcp-savvy/cdk';
import { AwsSolutionsChecks } from 'cdk-nag';
import { GatewayStack } from '../lib/gateway-stack.js';

const app = new cdk.App();
const env: cdk.Environment = {
    account: process.env['CDK_DEFAULT_ACCOUNT'],
    region: process.env['CDK_DEFAULT_REGION'] ?? 'us-east-1',
};
const region = env.region ?? 'us-east-1';

const oktaDomain = requiredEnv('OKTA_DOMAIN');
const oktaClientId = requiredEnv('OKTA_CLIENT_ID');
const sapMcpEndpoint = requiredSapRuntimeUrl('SAP_MCP_ENDPOINT', region, env.account);
const sapMcpProviderArn = requiredOAuthProviderArn(
    'SAP_MCP_OAUTH_PROVIDER_ARN',
    region,
    env.account,
);
const sapMcpSecretArn = requiredManagedSecretArn(
    'SAP_MCP_OAUTH_SECRET_ARN',
    region,
    env.account,
);
const sapMcpScopes = splitList(requiredEnv('SAP_MCP_SCOPES'));
const oktaOptions: OktaOidcOptions = {
    domain: oktaDomain,
    clientId: oktaClientId,
    ...(process.env['OKTA_AUTH_SERVER_ID']
        ? { authorizationServerId: process.env['OKTA_AUTH_SERVER_ID'] }
        : {}),
    ...(process.env['OKTA_AUDIENCE']
        ? { audience: process.env['OKTA_AUDIENCE'] }
        : {}),
};

new GatewayStack(app, 'McpSavvySapOktaGateway', {
    env,
    identityProvider: oktaExternalOidc(oktaOptions),
    sapMcpEndpoint,
    sapMcpProviderArn,
    sapMcpSecretArn,
    sapMcpScopes,
});

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

function requiredEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`${name} is required. See examples/gateway-sap-mcp-okta/README.md.`);
    }
    return value;
}

function requiredSapRuntimeUrl(name: string, region: string, account?: string): string {
    const value = requiredEnv(name);
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error(`${name} must be a valid URL.`);
    }
    const route = parsed.pathname.match(/^\/runtimes\/([^/]+)\/invocations$/u);
    const runtimeArn = route?.[1] ? decodeURIComponent(route[1]) : '';
    const arn = runtimeArn.match(
        /^arn:(aws|aws-us-gov):bedrock-agentcore:([a-z0-9-]+):(\d{12}):runtime\/[A-Za-z0-9_-]+$/u,
    );
    if (
        parsed.protocol !== 'https:' ||
        parsed.hostname !== `bedrock-agentcore.${region}.amazonaws.com` ||
        parsed.search !== '?qualifier=DEFAULT' ||
        parsed.hash !== '' ||
        !arn
    ) {
        throw new Error(`${name} must be an encoded AgentCore Runtime DEFAULT invocation URL.`);
    }
    assertCoordinates(name, arn[2], arn[3], region, account);
    return value;
}

function requiredOAuthProviderArn(name: string, region: string, account?: string): string {
    const value = requiredEnv(name);
    const arn = value.match(
        /^arn:(aws|aws-us-gov):acps:([A-Za-z0-9-]{1,64}):(\d{12}):token-vault\/[A-Za-z0-9.-]+\/oauth2credentialprovider\/[A-Za-z0-9.-]+$/u,
    );
    if (!arn) throw new Error(`${name} must be an AgentCore OAuth credential-provider ARN.`);
    assertCoordinates(name, arn[2], arn[3], region, account);
    return value;
}

function requiredManagedSecretArn(name: string, region: string, account?: string): string {
    const value = requiredEnv(name);
    const arn = value.match(
        /^arn:(aws|aws-us-gov):secretsmanager:([a-z0-9-]+):(\d{12}):secret:bedrock-agentcore-identity!.+$/u,
    );
    if (!arn) throw new Error(`${name} must be the AgentCore-managed OAuth secret ARN.`);
    assertCoordinates(name, arn[2], arn[3], region, account);
    return value;
}

function assertCoordinates(
    name: string,
    arnRegion: string | undefined,
    arnAccount: string | undefined,
    region: string,
    account?: string,
): void {
    if (arnRegion !== region || (account !== undefined && arnAccount !== account)) {
        throw new Error(`${name} must use the deployment account and region.`);
    }
}

function splitList(value: string): string[] {
    const entries = value.split(/[\s,]+/u).filter(Boolean);
    if (entries.length === 0) throw new Error('SAP_MCP_SCOPES must contain at least one scope.');
    return entries;
}
