/**
 * cdk-nag suppressions for `BedrockKnowledgeBase`.
 *
 * Pulled out of the construct body so the construct file stays
 * focused on resource composition. Each suppression is justified
 * inline and scoped via `appliesTo` per cdk-nag's granular-rule
 * guidance — see
 * https://github.com/cdklabs/cdk-nag/blob/main/RULES.md#granular-rule-suppression
 */

import type * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Stack } from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';

/** Inputs for `applyKnowledgeBaseNagSuppressions`. */
export interface ApplyKbNagSuppressionsInput {
    /** Construct scope, used for path-based suppressions. */
    readonly scope: Construct;
    /** The KB service role we attached the IAM grants to. */
    readonly serviceRole: iam.Role;
    /** True when we created the source bucket (vs BYO). */
    readonly createdSourceBucket: boolean;
    /** True when the operator passed an `accessLogsBucket` prop. */
    readonly hasAccessLogsBucket: boolean;
    /** The (possibly auto-created) source bucket — used for S1 path. */
    readonly sourceBucket: s3.IBucket;
    /**
     * True when `autoIngest` is set, so the construct owns the
     * ingestion custom resource + its `cr.Provider` (handler roles,
     * framework Lambda, and an async-waiter Step Function) whose
     * CDK-managed defaults cdk-nag flags.
     */
    readonly hasAutoIngest: boolean;
    /**
     * True when `corpus` is set, so the construct triggers CDK's
     * stack-level `BucketDeployment` singleton (uploader Lambda +
     * role) that lives at the stack root, outside this construct's
     * scope.
     */
    readonly hasCorpus: boolean;
}

/**
 * Suppress cdk-nag findings the construct's design intentionally
 * accepts, with justification + appliesTo scope per finding.
 */
export function applyKnowledgeBaseNagSuppressions(
    input: ApplyKbNagSuppressionsInput,
): void {
    // The `bedrock:Rerank` action does not support resource-level
    // permissions today (see the AWS Service Authorization Reference
    // for Bedrock — Rerank is in the "no resource" column). The
    // grant is necessary for the KB service role to call rerankers
    // configured on retrieval queries.
    //
    // The s3:GetObject grant on the source bucket uses the
    // documented `<bucket>/*` prefix grant — every object in the
    // KB's data source must be readable, by definition.
    NagSuppressions.addResourceSuppressions(
        input.serviceRole,
        [
            {
                id: 'AwsSolutions-IAM5',
                reason:
                    "bedrock:Rerank doesn't support resource-level " +
                    'permissions per the AWS Service Authorization ' +
                    'Reference (Bedrock). Wildcard is the documented ' +
                    'pattern. See ' +
                    'https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrock.html',
                appliesTo: ['Resource::*'],
            },
            {
                id: 'AwsSolutions-IAM5',
                reason:
                    'KB service role needs read on every object in ' +
                    'the source bucket — that is the whole point of ' +
                    'a data source. Scoped to the bucket-arn prefix.',
                appliesTo: [
                    'Resource::<KBSourceBucket02DA16DA.Arn>/*',
                ],
            },
        ],
        true,
    );

    // When the operator did not pass `accessLogsBucket`, the
    // auto-created source bucket has no S3 server-access logs.
    // Document the deliberate choice so cdk-nag passes — most
    // operators audit S3 access via CloudTrail S3 data-events
    // rather than per-bucket access logs, and a KB source bucket
    // is operator-driven (sync / ingest), not user-driven.
    if (input.createdSourceBucket && !input.hasAccessLogsBucket) {
        NagSuppressions.addResourceSuppressions(input.sourceBucket, [
            {
                id: 'AwsSolutions-S1',
                reason:
                    'Source bucket access is operator-driven (sync + ' +
                    'KB ingest). Audit trail belongs in CloudTrail S3 ' +
                    'data-events, not per-bucket access logs. Pass ' +
                    '`accessLogsBucket` to opt into S3 server-access ' +
                    'logs explicitly.',
            },
        ]);
    }

    if (input.hasAutoIngest) {
        applyAutoIngestSuppressions(input.scope);
    }
    if (input.hasCorpus) {
        applyBucketDeploymentSuppressions(input.scope);
    }
}

/**
 * Suppress findings on the in-scope resources `autoIngest` creates:
 * the two ingestion handler Lambdas + the `cr.Provider` framework
 * Lambda and its async-waiter Step Function. All live under this
 * construct's scope, so a scoped `addResourceSuppressions` reaches
 * them. These are deploy-time CDK helpers, not data-plane resources.
 */
function applyAutoIngestSuppressions(scope: Construct): void {
    NagSuppressions.addResourceSuppressions(
        scope,
        [
            {
                id: 'AwsSolutions-IAM4',
                reason:
                    'The cr.Provider framework Lambda uses ' +
                    'AWSLambdaBasicExecutionRole — the AWS-managed policy ' +
                    'granting only CloudWatch Logs writes. Standard CDK ' +
                    'default for custom-resource provider framework.',
                appliesTo: [
                    'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
                ],
            },
            {
                id: 'AwsSolutions-IAM5',
                reason:
                    'The ingestion handler grants scope to the KB ARN plus ' +
                    'its child-resource prefix (<kb-arn>/*); StartIngestionJob ' +
                    'and GetIngestionJob address the data source as a child of ' +
                    'the KB. The cr.Provider framework Lambda emits a ' +
                    'CDK-managed wildcard grant to invoke the construct-owned ' +
                    'handler functions. Deploy-time only.',
            },
            {
                id: 'AwsSolutions-L1',
                reason:
                    'The cr.Provider framework Lambda pins a runtime CDK ' +
                    "selects; its version is CDK-managed, not this construct's " +
                    'to set. The handlers we own run on NODEJS_22_X (current ' +
                    'supported latest).',
            },
            {
                id: 'AwsSolutions-SF1',
                reason:
                    "The cr.Provider async-waiter Step Function is CDK's " +
                    'custom-resource completion poller, created and configured ' +
                    'by the framework. It fires only during deploy and its ' +
                    'logging config is not exposed by the L2. No data-plane role.',
            },
            {
                id: 'AwsSolutions-SF2',
                reason:
                    "The cr.Provider async-waiter Step Function is CDK's " +
                    'custom-resource completion poller; X-Ray tracing is not ' +
                    'configurable on it and it runs only during deploy.',
            },
        ],
        true,
    );
}

/**
 * Suppress findings on CDK's `BucketDeployment` stack-level singleton
 * (uploader Lambda + role). It is created against the stack root —
 * outside this construct's scope — so we reach it by path. The exact
 * id carries a content hash, so we resolve it by walking the stack
 * for the `Custom::CDKBucketDeployment*` node rather than hardcoding.
 */
function applyBucketDeploymentSuppressions(scope: Construct): void {
    const stack = Stack.of(scope);
    const deploymentNode = stack.node
        .findAll()
        .find((c) => c.node.id.startsWith('Custom::CDKBucketDeployment'));
    if (!deploymentNode) return;
    NagSuppressions.addResourceSuppressions(
        deploymentNode,
        [
            {
                id: 'AwsSolutions-IAM4',
                reason:
                    "CDK's BucketDeployment uploader Lambda uses " +
                    'AWSLambdaBasicExecutionRole — the AWS-managed policy ' +
                    'granting only CloudWatch Logs writes. Stack-level ' +
                    'singleton CDK creates; not configurable.',
                appliesTo: [
                    'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
                ],
            },
            {
                id: 'AwsSolutions-IAM5',
                reason:
                    "CDK's BucketDeployment uploader needs read on the CDK " +
                    'assets bucket (source) and read/write/delete on the ' +
                    'destination source bucket to sync objects. The wildcard ' +
                    'object-level actions are CDK-managed and deploy-time only.',
            },
            {
                id: 'AwsSolutions-L1',
                reason:
                    "CDK's BucketDeployment uploader pins a runtime CDK " +
                    'selects; its version is CDK-managed and not exposed for ' +
                    'this construct to override.',
            },
        ],
        true,
    );
}
