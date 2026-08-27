/**
 * `BedrockKnowledgeBase` — opinionated, secure-by-default Bedrock
 * Knowledge Base backed by S3 Vectors.
 *
 * Composes the source bucket, vectors bucket + index, KB service
 * role, `CfnKnowledgeBase`, and `CfnDataSource`. Defaults match the
 * proven-working `.genia` pattern (Titan v2, 1024-d, FIXED_SIZE 512
 * + 20% overlap, RETAIN), but every choice is overridable via props.
 * Optional deploy-time `corpus` upload + `autoIngest` make a single
 * `cdk deploy` create-fill-and-index the KB. See the KB example README.
 */

import * as cdk from 'aws-cdk-lib';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

import type { BedrockKnowledgeBaseProps } from './types.js';
import { buildKbServiceRole } from './iam.js';
import { applyKnowledgeBaseNagSuppressions } from './nag.js';
import {
    deployCorpus,
    wireAutoIngestion,
    type DeployCorpusResult,
} from './ingestion.js';
import {
    createDataSource,
    createKnowledgeBase,
    createSourceBucket,
    createVectorStore,
    resolveConfig,
} from './resources.js';

/**
 * Bedrock Knowledge Base + S3 Vectors + S3 source bucket + IAM
 * service role, all in one construct.
 *
 * Outputs `knowledgeBaseId`, `knowledgeBaseArn`, `dataSourceId`,
 * `sourceBucket`, `vectorBucketName`, `vectorIndexName` for
 * downstream constructs (typically an `AgentCoreRuntime` consuming
 * the KB via the agent code).
 */
export class BedrockKnowledgeBase extends Construct {
    /** S3 bucket holding the source documents. */
    public readonly sourceBucket: s3.IBucket;
    /** Bedrock-assigned KB id (e.g. `ABCD1234EF`). */
    public readonly knowledgeBaseId: string;
    /** Full Bedrock KB ARN. */
    public readonly knowledgeBaseArn: string;
    /** Data-source id (used to trigger ingestion jobs). */
    public readonly dataSourceId: string;
    /** Name of the S3 Vectors bucket. */
    public readonly vectorBucketName: string;
    /** Name of the S3 Vectors index. */
    public readonly vectorIndexName: string;
    /** IAM role assumed by Bedrock to ingest + query. */
    public readonly serviceRole: iam.IRole;
    /**
     * The deploy-time corpus upload, when a `corpus` prop was given.
     * `undefined` otherwise.
     */
    public readonly corpusDeployment?: s3deploy.BucketDeployment;
    /**
     * The deploy-time ingestion custom resource, when `autoIngest`
     * was enabled. `undefined` otherwise.
     */
    public readonly ingestion?: cdk.CustomResource;

    constructor(
        scope: Construct,
        id: string,
        props: BedrockKnowledgeBaseProps = {},
    ) {
        super(scope, id);

        const stack = cdk.Stack.of(this);
        const accountId = stack.account;
        const region = stack.region;
        const cfg = resolveConfig(props, accountId, region);

        this.sourceBucket =
            props.sourceBucket ?? createSourceBucket(this, cfg, props);

        const { vectorBucket, vectorIndex, vectorIndexArn, vectorBucketArn } =
            createVectorStore(this, cfg);
        this.vectorBucketName = cfg.vectorBucketName;
        this.vectorIndexName = cfg.vectorIndexName;

        const embeddingModelArn = foundationModelArn(stack, region, cfg.embeddingModel);
        const rerankerModelArns = cfg.rerankerModels.map((modelId) =>
            foundationModelArn(stack, region, modelId),
        );

        const role = buildKbServiceRole({
            scope: this,
            accountId,
            region,
            embeddingModelArn,
            rerankerModelArns,
            sourceBucket: this.sourceBucket,
            vectorIndexArn,
        });
        this.serviceRole = role;

        const knowledgeBase = createKnowledgeBase(this, {
            cfg,
            roleArn: role.roleArn,
            embeddingModelArn,
            vectorBucketArn,
            vectorIndexArn,
        });
        knowledgeBase.addDependency(vectorIndex);
        // Avoid the policy-vs-KB creation race: the KB validates IAM
        // at create time, so depend on the role's DefaultPolicy too.
        const defaultPolicy = role.node.tryFindChild('DefaultPolicy');
        if (defaultPolicy) {
            knowledgeBase.addDependency(defaultPolicy.node.defaultChild as cdk.CfnResource);
        }
        this.knowledgeBaseId = knowledgeBase.attrKnowledgeBaseId;
        this.knowledgeBaseArn = knowledgeBase.attrKnowledgeBaseArn;

        const dataSource = createDataSource(this, cfg, knowledgeBase, this.sourceBucket);
        dataSource.addDependency(knowledgeBase);
        this.dataSourceId = dataSource.attrDataSourceId;

        const corpus = this.maybeDeployCorpus(props);
        this.corpusDeployment = corpus?.deployment;
        this.ingestion = this.maybeAutoIngest(props, corpus?.contentHash, dataSource);

        // Carry the user's removal policy onto every CFN child we own.
        knowledgeBase.applyRemovalPolicy(cfg.removalPolicy);
        dataSource.applyRemovalPolicy(cfg.removalPolicy);
        vectorIndex.applyRemovalPolicy(cfg.removalPolicy);
        vectorBucket.applyRemovalPolicy(cfg.removalPolicy);

        applyKnowledgeBaseNagSuppressions({
            scope: this,
            serviceRole: role,
            createdSourceBucket: !props.sourceBucket,
            hasAccessLogsBucket: !!props.accessLogsBucket,
            sourceBucket: this.sourceBucket,
            hasAutoIngest: !!props.autoIngest,
            hasCorpus: !!props.corpus,
        });
    }

    /**
     * Upload a local `corpus` directory into the source bucket at
     * deploy time (the "sync to S3" leg). Returns the deployment plus
     * the delivered asset's content hash (for use as the default
     * ingestion trigger), or `undefined` when no `corpus` was given.
     */
    private maybeDeployCorpus(
        props: BedrockKnowledgeBaseProps,
    ): DeployCorpusResult | undefined {
        if (!props.corpus) return undefined;
        return deployCorpus(this, this.sourceBucket, props.corpus);
    }

    /**
     * Run a Bedrock ingestion job as part of the deploy (the
     * "S3 → KB sync job" leg) when `autoIngest` is set. The trigger
     * defaults to the corpus content hash (so edits re-index), falls
     * back to an explicit `ingestionTrigger`, then to a stable
     * constant. Orders the job after the data source + corpus upload.
     * Returns the custom resource, or `undefined` when disabled.
     */
    private maybeAutoIngest(
        props: BedrockKnowledgeBaseProps,
        corpusContentHash: string | undefined,
        dataSource: cdk.CfnResource,
    ): cdk.CustomResource | undefined {
        if (!props.autoIngest) return undefined;
        const trigger = props.ingestionTrigger ?? corpusContentHash ?? 'initial';
        const ingestion = wireAutoIngestion(this, {
            knowledgeBaseId: this.knowledgeBaseId,
            knowledgeBaseArn: this.knowledgeBaseArn,
            dataSourceId: this.dataSourceId,
            trigger,
        });
        // Ingestion must see the data source and any freshly uploaded
        // corpus before it starts the job.
        ingestion.node.addDependency(dataSource);
        if (this.corpusDeployment) ingestion.node.addDependency(this.corpusDeployment);
        return ingestion;
    }
}

/** Format a Bedrock foundation-model ARN (account-less, regional). */
function foundationModelArn(stack: cdk.Stack, region: string, modelId: string): string {
    return cdk.Arn.format(
        {
            service: 'bedrock',
            account: '',
            region,
            resource: 'foundation-model',
            resourceName: modelId,
        },
        stack,
    );
}

export type {
    BedrockKnowledgeBaseProps,
    ChunkingConfig,
    KbCorpusSource,
} from './types.js';
