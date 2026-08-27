/**
 * Lambda construction helpers for `OAuthCompleteSessionApi`.
 *
 * Both Lambdas ship as pre-bundled assets from
 * `packages/cdk/dist-lambdas/<name>/index.mjs`, produced by
 * `packages/cdk/scripts/build-lambdas.mjs` at our build time.
 * Consumers of `@mcp-savvy/cdk` don't transitively install
 * `jose` or `@aws-sdk/client-bedrock-agentcore` — those bake into
 * the zip.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { JwtAuthorizerSpec } from '../identity/identityProvider.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Resolved at runtime to the package's `dist-lambdas/` directory. */
const LAMBDA_ASSETS_DIR = path.resolve(HERE, '..', '..', 'dist-lambdas');

/** Build the OIDC-generic Lambda authorizer (jose, Entra-aware). */
export function buildAuthorizerLambda(
    scope: Construct,
    spec: JwtAuthorizerSpec,
): lambda.Function {
    const logGroup = new logs.LogGroup(scope, 'AuthorizerFnLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    return new lambda.Function(scope, 'AuthorizerFn', {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(path.join(LAMBDA_ASSETS_DIR, 'jwt-authorizer')),
        timeout: cdk.Duration.seconds(10),
        memorySize: 256,
        logGroup,
        environment: {
            OIDC_ISSUER: spec.issuerUrl,
            OIDC_ALLOWED_AUDIENCE: JSON.stringify(spec.allowedAudience ?? []),
            OIDC_ALLOWED_CLIENTS: JSON.stringify(spec.allowedClients ?? []),
            OIDC_ALLOWED_SCOPES: JSON.stringify(spec.allowedScopes ?? []),
            ...(spec.customClaim !== undefined
                ? {
                    OIDC_CLIENT_CLAIM_NAME: spec.customClaim.name,
                    OIDC_CLIENT_CLAIM_VALUE: spec.customClaim.value,
                }
                : {}),
        },
        description:
            'mcp-savvy OAuthCompleteSessionApi: validates OIDC JWTs (Cognito + Entra v1/v2 + generic).',
    });
}

/** Build the complete-session Lambda (calls CompleteResourceTokenAuth). */
export function buildCompleteSessionLambda(scope: Construct): lambda.Function {
    const logGroup = new logs.LogGroup(scope, 'CompleteSessionFnLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const fn = new lambda.Function(scope, 'CompleteSessionFn', {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(path.join(LAMBDA_ASSETS_DIR, 'complete-session')),
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        logGroup,
        description:
            'mcp-savvy OAuthCompleteSessionApi: calls AgentCore Identity CompleteResourceTokenAuth.',
    });
    // Resource is `*` because sessionUris are not ARN-scoped — the
    // Lambda authorizer is what enforces user identity.
    fn.addToRolePolicy(
        new iam.PolicyStatement({
            actions: ['bedrock-agentcore:CompleteResourceTokenAuth'],
            resources: ['*'],
        }),
    );
    // CompleteResourceTokenAuth (called by this Lambda) needs to
    // read the OAuth credential provider's client secret from
    // Secrets Manager. AgentCore Identity stores those secrets
    // under the `bedrock-agentcore-identity!*` name prefix; we
    // grant access to that pattern (the same wildcard the L2
    // OAuthCredentialProviderConfiguration emits on the gateway
    // role).
    fn.addToRolePolicy(
        new iam.PolicyStatement({
            actions: ['secretsmanager:GetSecretValue'],
            resources: [
                cdk.Arn.format(
                    {
                        service: 'secretsmanager',
                        resource: 'secret',
                        resourceName: 'bedrock-agentcore-identity!*',
                        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
                    },
                    cdk.Stack.of(scope),
                ),
            ],
        }),
    );
    return fn;
}
