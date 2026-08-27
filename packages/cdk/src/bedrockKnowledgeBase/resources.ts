/**
 * Resource builders for `BedrockKnowledgeBase`.
 *
 * Free functions (each taking the construct `scope`) that create the
 * source bucket, S3 Vectors store, `CfnKnowledgeBase`, and
 * `CfnDataSource`, plus `resolveConfig` for prop defaulting. Pulled
 * out of `index.ts` so the construct body stays a thin composition
 * layer within the file-size budget.
 */

import * as cdk from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import type { Construct } from 'constructs';

import {
    DEFAULT_CHUNK_MAX_TOKENS,
    DEFAULT_CHUNK_OVERLAP_PERCENT,
    DEFAULT_EMBEDDING_DIMENSIONS,
    DEFAULT_EMBEDDING_MODEL,
    DEFAULT_RERANKER_MODELS,
    type BedrockKnowledgeBaseProps,
    type ResolvedKbConfig,
} from './types.js';
import { buildChunkingCfn } from './chunking.js';

/** The created S3 Vectors store plus the ARNs the KB wiring needs. */
export interface VectorStore {
    readonly vectorBucket: s3vectors.CfnVectorBucket;
    readonly vectorIndex: s3vectors.CfnIndex;
    readonly vectorBucketArn: string;
    readonly vectorIndexArn: string;
}

/** Apply defaults to the user-supplied props. */
export function resolveConfig(
    props: BedrockKnowledgeBaseProps,
    accountId: string,
    region: string,
): ResolvedKbConfig {
    const knowledgeBaseName = props.knowledgeBaseName ?? 'mcp-savvy-kb';
    const removalPolicy = props.removalPolicy ?? cdk.RemovalPolicy.RETAIN;
    return {
        knowledgeBaseName,
        knowledgeBaseDescription:
            props.knowledgeBaseDescription ??
            'mcp-savvy Bedrock Knowledge Base over S3 Vectors',
        embeddingModel: props.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
        embeddingDimensions:
            props.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS,
        rerankerModels: props.rerankerModels ?? DEFAULT_RERANKER_MODELS,
        chunking: {
            strategy: props.chunking?.strategy ?? 'FIXED_SIZE',
            maxTokens: props.chunking?.maxTokens ?? DEFAULT_CHUNK_MAX_TOKENS,
            overlapPercentage:
                props.chunking?.overlapPercentage ?? DEFAULT_CHUNK_OVERLAP_PERCENT,
        },
        vectorBucketName:
            props.vectorBucketName ??
            `${knowledgeBaseName}-vectors-${accountId}-${region}`,
        vectorIndexName: props.vectorIndexName ?? `${knowledgeBaseName}-index`,
        removalPolicy,
    };
}

/** Create the hardened source bucket (only when no BYO bucket given). */
export function createSourceBucket(
    scope: Construct,
    cfg: ResolvedKbConfig,
    props: BedrockKnowledgeBaseProps,
): s3.Bucket {
    return new s3.Bucket(scope, 'SourceBucket', {
        ...(props.sourceBucketName ? { bucketName: props.sourceBucketName } : {}),
        encryption: s3.BucketEncryption.S3_MANAGED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        versioned: true,
        ...(props.accessLogsBucket
            ? {
                serverAccessLogsBucket: props.accessLogsBucket,
                serverAccessLogsPrefix: `${cfg.knowledgeBaseName}-source/`,
            }
            : {}),
        lifecycleRules: [
            {
                noncurrentVersionExpiration: cdk.Duration.days(30),
                abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
            },
        ],
        removalPolicy: cfg.removalPolicy,
        // Auto-delete only when the user explicitly asked for DESTROY.
        autoDeleteObjects: cfg.removalPolicy === cdk.RemovalPolicy.DESTROY,
    });
}

/** Create the S3 Vectors bucket + index sized to the embedding model. */
export function createVectorStore(
    scope: Construct,
    cfg: ResolvedKbConfig,
): VectorStore {
    const stack = cdk.Stack.of(scope);
    const vectorBucket = new s3vectors.CfnVectorBucket(scope, 'VectorBucket', {
        vectorBucketName: cfg.vectorBucketName,
        encryptionConfiguration: { sseType: 'AES256' },
    });
    const vectorIndex = new s3vectors.CfnIndex(scope, 'VectorIndex', {
        vectorBucketName: cfg.vectorBucketName,
        indexName: cfg.vectorIndexName,
        dataType: 'float32',
        dimension: cfg.embeddingDimensions,
        distanceMetric: 'cosine',
        // Bedrock KB writes chunk text + chunk metadata into S3
        // Vectors. Both must be non-filterable to fit within the
        // 2KB filterable budget for long file paths.
        metadataConfiguration: {
            nonFilterableMetadataKeys: [
                'AMAZON_BEDROCK_TEXT',
                'AMAZON_BEDROCK_METADATA',
            ],
        },
    });
    vectorIndex.addDependency(vectorBucket);
    const vectorBucketArn = cdk.Arn.format(
        {
            service: 's3vectors',
            resource: 'bucket',
            resourceName: cfg.vectorBucketName,
        },
        stack,
    );
    const vectorIndexArn = `${vectorBucketArn}/index/${cfg.vectorIndexName}`;
    return { vectorBucket, vectorIndex, vectorBucketArn, vectorIndexArn };
}

/** Arguments for `createKnowledgeBase`. */
export interface CreateKnowledgeBaseArgs {
    readonly cfg: ResolvedKbConfig;
    readonly roleArn: string;
    readonly embeddingModelArn: string;
    readonly vectorBucketArn: string;
    readonly vectorIndexArn: string;
}

/** Create the `CfnKnowledgeBase` (VECTOR type over S3 Vectors). */
export function createKnowledgeBase(
    scope: Construct,
    args: CreateKnowledgeBaseArgs,
): bedrock.CfnKnowledgeBase {
    return new bedrock.CfnKnowledgeBase(scope, 'KnowledgeBase', {
        name: args.cfg.knowledgeBaseName,
        description: args.cfg.knowledgeBaseDescription,
        roleArn: args.roleArn,
        knowledgeBaseConfiguration: {
            type: 'VECTOR',
            vectorKnowledgeBaseConfiguration: {
                embeddingModelArn: args.embeddingModelArn,
                embeddingModelConfiguration: {
                    bedrockEmbeddingModelConfiguration: {
                        dimensions: args.cfg.embeddingDimensions,
                        embeddingDataType: 'FLOAT32',
                    },
                },
            },
        },
        storageConfiguration: {
            type: 'S3_VECTORS',
            s3VectorsConfiguration: {
                vectorBucketArn: args.vectorBucketArn,
                indexArn: args.vectorIndexArn,
            },
        },
    });
}

/** Create the S3 `CfnDataSource` with the resolved chunking config. */
export function createDataSource(
    scope: Construct,
    cfg: ResolvedKbConfig,
    kb: bedrock.CfnKnowledgeBase,
    sourceBucket: s3.IBucket,
): bedrock.CfnDataSource {
    return new bedrock.CfnDataSource(scope, 'DataSource', {
        name: `${cfg.knowledgeBaseName}-data-source`,
        knowledgeBaseId: kb.attrKnowledgeBaseId,
        dataSourceConfiguration: {
            type: 'S3',
            s3Configuration: { bucketArn: sourceBucket.bucketArn },
        },
        vectorIngestionConfiguration: {
            chunkingConfiguration: buildChunkingCfn(cfg.chunking),
        },
        dataDeletionPolicy:
            cfg.removalPolicy === cdk.RemovalPolicy.DESTROY ? 'DELETE' : 'RETAIN',
    });
}
