/**
 * Deploy-time corpus delivery + ingestion for `BedrockKnowledgeBase`.
 *
 * Two opt-in halves that turn `cdk deploy` into a one-step "create
 * the bucket, fill it, and index it" flow:
 *   - `deployCorpus` uploads a local directory into the source
 *     bucket via `s3deploy.BucketDeployment` (the "sync to S3" leg).
 *   - `wireAutoIngestion` runs a Bedrock ingestion job through a
 *     Lambda-backed async custom resource (the "S3 → KB sync job"
 *     leg), mirroring `examples/kb-mcp/scripts/ingest.mjs`.
 *
 * Kept out of the construct body so `index.ts` stays focused on
 * resource composition and within the file-size budget.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { CustomResource, Duration, custom_resources as cr } from 'aws-cdk-lib';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type { KbCorpusSource } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * Path to the bundled `kb-ingest` Lambda asset.
 * `scripts/build-lambdas.mjs` pre-bundles it (CJS, all deps inlined)
 * at build time so consumers of `@mcp-savvy/cdk` don't transitively
 * install `@aws-sdk/client-bedrock-agent`.
 */
const ASSET_PATH = path.resolve(HERE, '..', '..', 'dist-lambdas', 'kb-ingest');

/** Log retention for the construct's deploy-time Lambdas. */
const LOG_RETENTION = logs.RetentionDays.ONE_WEEK;
/** How often `cr.Provider` re-polls the ingestion job for completion. */
const INGEST_POLL_INTERVAL = Duration.seconds(15);
/** Hard ceiling on how long we wait for an ingestion job to finish. */
const INGEST_TOTAL_TIMEOUT = Duration.minutes(30);

/** Result of `deployCorpus` — the deployment plus a content hash. */
export interface DeployCorpusResult {
    /** The bucket-deployment that uploads the corpus at deploy time. */
    readonly deployment: s3deploy.BucketDeployment;
    /**
     * Content-derived hash of the delivered directory. Used as the
     * default ingestion trigger so corpus edits re-index on redeploy.
     */
    readonly contentHash: string;
}

/**
 * Upload a local directory into the source bucket at deploy time.
 * Uses an `s3_assets.Asset` for the upload payload so the asset's
 * content hash can double as the ingestion trigger.
 */
export function deployCorpus(
    scope: Construct,
    sourceBucket: s3.IBucket,
    corpus: KbCorpusSource,
): DeployCorpusResult {
    const asset = new s3assets.Asset(scope, 'CorpusAsset', {
        path: corpus.path,
        ...(corpus.exclude ? { exclude: [...corpus.exclude] } : {}),
    });
    const deployment = new s3deploy.BucketDeployment(scope, 'CorpusDeployment', {
        sources: [s3deploy.Source.bucket(asset.bucket, asset.s3ObjectKey)],
        destinationBucket: sourceBucket,
        ...(corpus.keyPrefix ? { destinationKeyPrefix: corpus.keyPrefix } : {}),
        // Never delete objects the operator synced out-of-band; the
        // corpus is additive over whatever already lives in the bucket.
        prune: false,
    });
    return { deployment, contentHash: asset.assetHash };
}

/** Inputs for `wireAutoIngestion`. */
export interface WireAutoIngestionProps {
    /** Bedrock KB id the ingestion job targets. */
    readonly knowledgeBaseId: string;
    /** Full KB ARN — used to scope the ingestion IAM grants. */
    readonly knowledgeBaseArn: string;
    /** Data-source id whose documents get (re-)indexed. */
    readonly dataSourceId: string;
    /** Opaque value; a change forces a fresh ingestion job. */
    readonly trigger: string;
}

/**
 * Run a Bedrock ingestion job as part of the deploy via an async
 * custom resource (`onEvent` starts the job, `isComplete` polls).
 * Returns the custom resource so the caller can order it after the
 * data source + corpus delivery.
 */
export function wireAutoIngestion(
    scope: Construct,
    props: WireAutoIngestionProps,
): CustomResource {
    const startFn = buildIngestFn(scope, 'KbIngestStartFn', 'index.onEvent', {
        actions: ['bedrock:StartIngestionJob'],
        knowledgeBaseArn: props.knowledgeBaseArn,
    });
    const pollFn = buildIngestFn(scope, 'KbIngestPollFn', 'index.isComplete', {
        actions: ['bedrock:GetIngestionJob'],
        knowledgeBaseArn: props.knowledgeBaseArn,
    });

    const providerLogs = new logs.LogGroup(scope, 'KbIngestProviderLogs', {
        retention: LOG_RETENTION,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const provider = new cr.Provider(scope, 'KbIngestProvider', {
        onEventHandler: startFn,
        isCompleteHandler: pollFn,
        queryInterval: INGEST_POLL_INTERVAL,
        totalTimeout: INGEST_TOTAL_TIMEOUT,
        logGroup: providerLogs,
    });

    return new CustomResource(scope, 'KbIngest', {
        serviceToken: provider.serviceToken,
        properties: {
            KnowledgeBaseId: props.knowledgeBaseId,
            DataSourceId: props.dataSourceId,
            Trigger: props.trigger,
        },
        resourceType: 'Custom::McpSavvyKbIngestion',
    });
}

/** Build one of the two ingestion Lambdas with a scoped IAM grant. */
function buildIngestFn(
    scope: Construct,
    id: string,
    handler: string,
    grant: { readonly actions: string[]; readonly knowledgeBaseArn: string },
): lambda.Function {
    const fnLogs = new logs.LogGroup(scope, `${id}Logs`, {
        retention: LOG_RETENTION,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const fn = new lambda.Function(scope, id, {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler,
        code: lambda.Code.fromAsset(ASSET_PATH),
        timeout: Duration.seconds(30),
        memorySize: 256,
        logGroup: fnLogs,
        description:
            'mcp-savvy BedrockKnowledgeBase: deploy-time KB ingestion job ' +
            `(${handler}).`,
    });
    fn.addToRolePolicy(
        new iam.PolicyStatement({
            actions: grant.actions,
            // Ingestion APIs scope to the KB ARN; the data source is a
            // child resource of the same KB.
            resources: [grant.knowledgeBaseArn, `${grant.knowledgeBaseArn}/*`],
        }),
    );
    return fn;
}
