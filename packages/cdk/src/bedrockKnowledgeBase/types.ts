/**
 * Public types for the `BedrockKnowledgeBase` construct.
 */

import type * as cdk from 'aws-cdk-lib';
import type * as s3 from 'aws-cdk-lib/aws-s3';

/** Default embedding model. Titan v2 with 1024-dimension output. */
export const DEFAULT_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';
/** Default vector dimensions — must match Titan v2 default output. */
export const DEFAULT_EMBEDDING_DIMENSIONS = 1024;
/** Default chunking strategy — fits within S3 Vectors metadata budget. */
export const DEFAULT_CHUNK_MAX_TOKENS = 512;
/** Default chunk overlap percentage. */
export const DEFAULT_CHUNK_OVERLAP_PERCENT = 20;
/** Default rerankers granted to the KB service role. */
export const DEFAULT_RERANKER_MODELS: readonly string[] = [
    'cohere.rerank-v3-5:0',
    'amazon.rerank-v1:0',
];

/**
 * A local directory whose contents are uploaded into the KB source
 * bucket at deploy time (the "sync to S3" half of the turnkey
 * loop). Delivered verbatim via an `s3deploy.BucketDeployment`.
 *
 * Bedrock-native per-document metadata is supported the standard
 * way: drop a `<filename>.metadata.json` sidecar next to each
 * source file and it ships like any other object. The richer
 * frontmatter-to-`x-amz-meta-*` mapping used by the examples'
 * `sync.mjs` is intentionally out of scope here — the construct
 * delivers files; the example script remains the path for
 * metadata-rich syncs.
 */
export interface KbCorpusSource {
    /** Absolute or app-relative path to the local source directory. */
    readonly path: string;
    /**
     * Key prefix under which the directory is uploaded. Defaults to
     * `''` (bucket root). The examples use `'posts/'`.
     */
    readonly keyPrefix?: string;
    /** Glob patterns to exclude from the upload. */
    readonly exclude?: readonly string[];
}

/** Chunking configuration for the data source. Mirrors Bedrock KB shape. */
export interface ChunkingConfig {
    /**
     * Strategy. Default `'FIXED_SIZE'` — hierarchical chunking
     * serializes parent-child relationships into S3 Vectors metadata
     * and can blow the 2KB filterable budget on long-form markdown.
     */
    readonly strategy?: 'FIXED_SIZE' | 'HIERARCHICAL' | 'SEMANTIC' | 'NONE';
    /** Max tokens per chunk. Default 512. */
    readonly maxTokens?: number;
    /** Overlap percentage between adjacent chunks. Default 20. */
    readonly overlapPercentage?: number;
}

/** Configuration for the `BedrockKnowledgeBase` construct. */
export interface BedrockKnowledgeBaseProps {
    /**
     * Bring-your-own data source bucket. When omitted, the construct
     * creates one (SSE-S3, BPA, versioned, RETAIN). Pass an existing
     * bucket if you already have one or want to manage its lifecycle
     * separately.
     */
    readonly sourceBucket?: s3.IBucket;
    /**
     * Embedding foundation-model ID. Defaults to
     * `amazon.titan-embed-text-v2:0`. Pass any Bedrock embedding
     * model ID; whatever you pick must produce vectors of
     * `embeddingDimensions` length.
     */
    readonly embeddingModel?: string;
    /**
     * Output dimension of the embedding model. Default 1024 (matches
     * Titan v2 default). Must match what `embeddingModel` produces.
     */
    readonly embeddingDimensions?: number;
    /**
     * Reranker model IDs the KB service role is granted
     * `bedrock:InvokeModel` on. Defaults to Cohere 3.5 + Amazon
     * Rerank v1. Pass an empty array to skip the grant.
     */
    readonly rerankerModels?: readonly string[];
    /** Chunking configuration. See `ChunkingConfig` for defaults. */
    readonly chunking?: ChunkingConfig;
    /**
     * Local source directory to upload into the source bucket at
     * deploy time, turning `cdk deploy` into a one-step "create the
     * bucket, fill it, and index it" flow. When omitted, the bucket
     * is created empty and you sync into it yourself (e.g. the
     * examples' `kb-sync` script). Has no effect on the documents
     * already in a BYO `sourceBucket` beyond adding these.
     */
    readonly corpus?: KbCorpusSource;
    /**
     * Run a Bedrock ingestion job as part of the deploy, so the KB
     * is queryable the moment `cdk deploy` returns — no manual
     * `StartIngestionJob` step. Defaults to `false`.
     *
     * When `true`, a Lambda-backed custom resource starts an
     * ingestion job and polls until it reaches a terminal state.
     * The job runs on create and whenever `ingestionTrigger`
     * changes; pair it with `corpus` (or bump `ingestionTrigger`
     * after your own sync) to re-index on redeploy.
     */
    readonly autoIngest?: boolean;
    /**
     * Opaque value that forces a fresh ingestion job whenever it
     * changes (only meaningful when `autoIngest` is `true`). When a
     * `corpus` is supplied, the construct derives a default trigger
     * from the delivered asset's hash, so corpus edits re-ingest
     * automatically. Set this explicitly when you sync the bucket
     * out-of-band and want a redeploy to re-index.
     */
    readonly ingestionTrigger?: string;
    /**
     * Friendly name for the knowledge base. Defaults to
     * `'mcp-savvy-kb'`. Used verbatim as the KB name and (with
     * `-data-source` suffix) as the data-source name.
     */
    readonly knowledgeBaseName?: string;
    /**
     * Description for the knowledge base. Defaults to a short
     * generic string.
     */
    readonly knowledgeBaseDescription?: string;
    /**
     * Override for the S3 Vectors bucket name. Defaults to
     * `<kb-name>-vectors-<account>-<region>`.
     */
    readonly vectorBucketName?: string;
    /**
     * Override for the S3 Vectors index name. Defaults to
     * `<kb-name>-index`.
     */
    readonly vectorIndexName?: string;
    /**
     * Override for the auto-created source bucket's name (only used
     * when `sourceBucket` is not supplied). Defaults to
     * `<kb-name>-source-<account>-<region>`.
     */
    readonly sourceBucketName?: string;
    /**
     * Removal policy for created resources (source bucket, vector
     * bucket/index, KB, data source). Defaults to
     * `cdk.RemovalPolicy.RETAIN`.
     */
    readonly removalPolicy?: cdk.RemovalPolicy;
    /**
     * Optional bucket to deliver the auto-created source bucket's S3
     * server-access logs to. When set, the source bucket logs every
     * read/write to this bucket (cdk-nag's AwsSolutions-S1 default).
     * When omitted, the construct emits an explicit nag suppression
     * with the rationale that the source bucket is operator-driven
     * and the audit trail belongs in CloudTrail S3 data-events. Has
     * no effect when `sourceBucket` is supplied (BYO).
     */
    readonly accessLogsBucket?: s3.IBucket;
}

/** Resolved values used internally — every prop with defaults applied. */
export interface ResolvedKbConfig {
    readonly knowledgeBaseName: string;
    readonly knowledgeBaseDescription: string;
    readonly embeddingModel: string;
    readonly embeddingDimensions: number;
    readonly rerankerModels: readonly string[];
    readonly chunking: Required<ChunkingConfig>;
    readonly vectorBucketName: string;
    readonly vectorIndexName: string;
    readonly removalPolicy: cdk.RemovalPolicy;
}
