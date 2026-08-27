/**
 * IAM service role + policies for the Bedrock KB.
 *
 * Pulled out of the construct body so the construct file stays
 * focused on resource composition. Every policy is least-privilege
 * scoped to this KB's resources.
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/** Inputs for `buildKbServiceRole`. */
export interface KbServiceRoleProps {
    /** Construct scope (the KB construct itself). */
    readonly scope: Construct;
    /** Logical id within the scope. Defaults to `'ServiceRole'`. */
    readonly id?: string;
    /** AWS account id (from the parent stack). */
    readonly accountId: string;
    /** AWS region (from the parent stack). */
    readonly region: string;
    /** ARN of the embedding foundation-model. */
    readonly embeddingModelArn: string;
    /** ARNs of any reranker foundation-models the role can invoke. */
    readonly rerankerModelArns: readonly string[];
    /** Source bucket the KB reads documents from. */
    readonly sourceBucket: s3.IBucket;
    /** ARN of the S3 Vectors index. */
    readonly vectorIndexArn: string;
    /** Optional friendly role name. */
    readonly roleName?: string;
}

/**
 * Build the KB service role with least-privilege IAM. Returns the
 * role; the caller is expected to wire it into the
 * `CfnKnowledgeBase.roleArn` and to add a CFN dependency from the
 * KB resource to `role.node.tryFindChild('DefaultPolicy')` to avoid
 * the policy-vs-KB creation race documented in genia.
 */
export function buildKbServiceRole(props: KbServiceRoleProps): iam.Role {
    const role = new iam.Role(props.scope, props.id ?? 'ServiceRole', {
        ...(props.roleName ? { roleName: props.roleName } : {}),
        assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
            conditions: {
                StringEquals: { 'aws:SourceAccount': props.accountId },
                ArnLike: {
                    'aws:SourceArn': cdk.Arn.format(
                        {
                            service: 'bedrock',
                            account: props.accountId,
                            region: props.region,
                            resource: 'knowledge-base',
                            resourceName: '*',
                        },
                        cdk.Stack.of(props.scope),
                    ),
                },
            },
        }),
        description: 'mcp-savvy BedrockKnowledgeBase service role',
    });

    role.addToPolicy(
        new iam.PolicyStatement({
            sid: 'InvokeEmbeddingModel',
            effect: iam.Effect.ALLOW,
            actions: ['bedrock:InvokeModel'],
            resources: [props.embeddingModelArn],
        }),
    );

    if (props.rerankerModelArns.length > 0) {
        role.addToPolicy(
            new iam.PolicyStatement({
                sid: 'InvokeRerankerModel',
                effect: iam.Effect.ALLOW,
                actions: ['bedrock:InvokeModel'],
                resources: [...props.rerankerModelArns],
            }),
        );
        // Bedrock Rerank action is separate from InvokeModel and isn't
        // ARN-scopable today.
        role.addToPolicy(
            new iam.PolicyStatement({
                sid: 'RerankAction',
                effect: iam.Effect.ALLOW,
                actions: ['bedrock:Rerank'],
                resources: ['*'],
            }),
        );
    }

    role.addToPolicy(
        new iam.PolicyStatement({
            sid: 'ReadSourceBucket',
            effect: iam.Effect.ALLOW,
            actions: ['s3:GetObject', 's3:ListBucket'],
            resources: [
                props.sourceBucket.bucketArn,
                props.sourceBucket.arnForObjects('*'),
            ],
            conditions: {
                StringEquals: { 'aws:ResourceAccount': props.accountId },
            },
        }),
    );

    role.addToPolicy(
        new iam.PolicyStatement({
            sid: 'S3VectorsReadAndWrite',
            effect: iam.Effect.ALLOW,
            actions: [
                's3vectors:PutVectors',
                's3vectors:GetVectors',
                's3vectors:DeleteVectors',
                's3vectors:QueryVectors',
                's3vectors:GetIndex',
            ],
            resources: [props.vectorIndexArn],
        }),
    );

    return role;
}
