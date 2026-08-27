/**
 * Workload-identity callback-URL registration helper.
 *
 * The bridge's local-loopback callback (e.g.
 * `http://localhost:33424/oauth2/callback`) must appear in
 * `AllowedResourceOauth2ReturnUrls` on the gateway's workload
 * identity, otherwise AgentCore Identity refuses to redirect users
 * back to the bridge after consent. We register them via a tiny
 * Lambda-backed custom resource that does two SDK calls in
 * sequence: `GetGateway` to resolve the runtime workload-identity
 * name (the L2 gateway appends a 10-character suffix that's not
 * surfaced as a CFN attribute), then `UpdateWorkloadIdentity` to
 * attach the URLs.
 *
 * Why a custom Lambda rather than two `AwsCustomResource`s: each
 * `AwsCustomResource` emits its own `AWS::IAM::Policy` resource
 * against the singleton-role; CFN can run the second invocation
 * before the second policy attaches, and IAM's eventual consistency
 * surfaces as `AccessDenied` on `UpdateWorkloadIdentity`. One
 * Lambda with one role and one policy eliminates the race.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { CustomResource, custom_resources as cr } from 'aws-cdk-lib';
import { Construct } from 'constructs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * Path to the bundled `register-return-urls` Lambda asset.
 * `scripts/build-lambdas.mjs` pre-bundles it at build time so the
 * construct's consumers don't transitively install
 * `@aws-sdk/client-bedrock-agentcore-control`.
 */
const ASSET_PATH = path.resolve(HERE, '..', '..', 'dist-lambdas', 'register-return-urls');

/**
 * Default loopback URLs registered on the workload identity. The 3LO
 * second-leg callback runs on a *different* port than the first leg
 * (port 33423 is held by the first-leg `CallbackServer` for
 * `/callback`); we use **33424** as the canonical 3LO port. The
 * legacy 33419 covers older bridge versions if any.
 */
export const DEFAULT_LOOPBACK_URLS: readonly string[] = [
    'http://localhost:33424/oauth2/callback',
    'http://127.0.0.1:33424/oauth2/callback',
    'http://localhost:33419/oauth2/callback',
    'http://127.0.0.1:33419/oauth2/callback',
];

/**
 * Register the bridge's loopback URLs on the gateway's workload
 * identity. Lives at deploy time only — no `onDelete`, because the
 * workload identity is destroyed with the gateway and an
 * `UpdateWorkloadIdentity` after the gateway is gone races and fails.
 */
export function registerLoopbackUrls(
    scope: Construct,
    gatewayId: string,
    urls: readonly string[],
): CustomResource {
    const handlerLogs = new logs.LogGroup(scope, 'RegisterReturnUrlsFnLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const handler = new lambda.Function(scope, 'RegisterReturnUrlsFn', {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(ASSET_PATH),
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        description:
            'mcp-savvy OAuthCompleteSessionApi: registers bridge loopback URLs on the gateway workload identity.',
        logGroup: handlerLogs,
    });
    handler.addToRolePolicy(
        new iam.PolicyStatement({
            actions: [
                'bedrock-agentcore:GetGateway',
                'bedrock-agentcore:UpdateWorkloadIdentity',
            ],
            resources: ['*'],
        }),
    );

    const providerLogs = new logs.LogGroup(scope, 'RegisterReturnUrlsProviderLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const provider = new cr.Provider(scope, 'RegisterReturnUrlsProvider', {
        onEventHandler: handler,
        logGroup: providerLogs,
    });

    return new CustomResource(scope, 'RegisterReturnUrls', {
        serviceToken: provider.serviceToken,
        properties: {
            // CDK custom-resource properties are passed verbatim to
            // the handler. Newline-joined URL list keeps the shape
            // simple and the property table compact in CloudFormation.
            GatewayId: gatewayId,
            LoopbackUrls: urls.join('\n'),
        },
        resourceType: 'Custom::OAuthCompleteRegisterReturnUrls',
    });
}
