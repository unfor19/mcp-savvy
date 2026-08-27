/**
 * cdk-nag suppressions for `OAuthCompleteSessionApi`.
 *
 * Lifted into its own file so the construct's main implementation
 * stays focused on resource composition. Each suppression is paired
 * with the threat-model reasoning so future audits don't need to
 * re-derive why each one is appropriate here.
 */

import { NagSuppressions } from 'cdk-nag';
import { Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';

/** Apply every cdk-nag suppression `OAuthCompleteSessionApi` needs. */
export function applyOAuthCompleteSessionNagSuppressions(scope: Construct): void {
    applyConstructLevelSuppressions(scope);
    applyStackLevelSuppressions(scope);
}

/** Suppressions on resources owned by the construct itself. */
function applyConstructLevelSuppressions(scope: Construct): void {
    NagSuppressions.addResourceSuppressions(
        scope,
        [
            {
                id: 'AwsSolutions-IAM4',
                reason:
                    'L2 Lambda execution roles use AWSLambdaBasicExecutionRole, ' +
                    'the AWS-managed policy that grants only CloudWatch Logs ' +
                    'write permissions for the function\'s own log group. ' +
                    'Standard L2 default; minimum a Lambda needs.',
                appliesTo: [
                    'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
                ],
            },
            {
                id: 'AwsSolutions-IAM5',
                reason:
                    'CompleteResourceTokenAuth and UpdateWorkloadIdentity have no ' +
                    'ARN-scoped resource — sessionUris and workload-identity names ' +
                    'are not resource ARNs. The Lambda authorizer enforces the ' +
                    'user-identity gate; the custom resource only fires at deploy.',
            },
            {
                id: 'AwsSolutions-L1',
                reason:
                    'NODEJS_22_X is the current AWS-supported latest Node Lambda ' +
                    'runtime; cdk-nag\'s internal "latest" map lags releases. ' +
                    'Re-evaluate on cdk-nag upgrades.',
            },
            {
                id: 'AwsSolutions-APIG2',
                reason:
                    'Request validation is the responsibility of the complete-session ' +
                    'Lambda which performs strict JSON shape validation; the API ' +
                    'Gateway request-validator would only duplicate that work and ' +
                    'add per-call latency for negligible benefit.',
            },
            {
                id: 'AwsSolutions-APIG3',
                reason:
                    'WAF is opt-in via composition with `ApiGatewayFrontDoor` (section 8.4), ' +
                    'which adds the AWS managed core rule sets. The default deploy ' +
                    'is a vanilla regional REST API.',
            },
            {
                id: 'AwsSolutions-APIG4',
                reason:
                    'The POST /complete-session route is gated by a Lambda authorizer ' +
                    'that validates the OIDC JWT. cdk-nag flags the auto-generated ' +
                    'CORS OPTIONS preflight which is unauthenticated by design.',
            },
            {
                id: 'AwsSolutions-COG4',
                reason:
                    'COG4 expects a Cognito user-pool authorizer; we deliberately use ' +
                    'a generic Lambda authorizer so non-Cognito IdPs (Entra/Okta/etc) ' +
                    'work uniformly. See SECURITY.md for the threat model.',
            },
            {
                id: 'AwsSolutions-APIG1',
                reason:
                    'Access logging is opt-in via composition with `ApiGatewayFrontDoor` ' +
                    '(section 8.4) for teams that need it. The default deploy keeps the API ' +
                    'minimal — the complete-session endpoint fires once per OAuth ' +
                    'completion, and its handler emits privacy-safe structured outcome ' +
                    'records. Teams needing full request access logs can opt in.',
            },
            {
                id: 'AwsSolutions-APIG6',
                reason:
                    'The completion handler emits privacy-safe structured outcome records. ' +
                    'Teams that need API Gateway stage-level execution logs can compose ' +
                    'with `ApiGatewayFrontDoor` (section 8.4).',
            },
        ],
        true,
    );
}

/**
 * Suppressions on stack-level singletons CDK creates implicitly.
 * These resources live at the stack root, not under the construct,
 * so `addResourceSuppressions(scope, ...)` cannot reach them.
 */
function applyStackLevelSuppressions(scope: Construct): void {
    const stack = Stack.of(scope);
    // API Gateway creates a single account-wide CloudWatch role per
    // stack at `Api/CloudWatchRole` whenever any RestApi enables
    // logging. The role uses the AWS-managed
    // `AmazonAPIGatewayPushToCloudWatchLogs` policy which is exactly
    // the minimum API Gateway needs for log delivery.
    const apiCloudWatchRolePath = `${scope.node.path}/Api/CloudWatchRole/Resource`;
    NagSuppressions.addResourceSuppressionsByPath(stack, apiCloudWatchRolePath, [
        {
            id: 'AwsSolutions-IAM4',
            reason:
                'API Gateway account-wide CloudWatch role. Uses the AWS-managed ' +
                'AmazonAPIGatewayPushToCloudWatchLogs policy — the minimum ' +
                'API Gateway needs to write access logs.',
            appliesTo: [
                'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs',
            ],
        },
    ]);
}
