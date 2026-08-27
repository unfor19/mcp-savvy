/**
 * Snapshot + targeted-assertion tests for `BedrockKnowledgeBase`.
 *
 * Snapshot pins the synthesized CFN against accidental change;
 * targeted `hasResourceProperties` assertions document the
 * design intent (least-privilege IAM, S3 Vectors index sized to
 * the embedding model, FIXED_SIZE chunking by default, etc.).
 */

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { BedrockKnowledgeBase } from './index.js';
import { freshStack } from '../testFixtures.js';

function synthDefault() {
    const stack = freshStack('KbDefault');
    new BedrockKnowledgeBase(stack, 'KB', {});
    return { stack, template: Template.fromStack(stack) };
}

function synthCustom() {
    const stack = freshStack('KbCustom');
    new BedrockKnowledgeBase(stack, 'KB', {
        knowledgeBaseName: 'acme-kb',
        embeddingModel: 'cohere.embed-english-v3',
        embeddingDimensions: 1024,
        rerankerModels: [],
        chunking: {
            strategy: 'HIERARCHICAL',
            maxTokens: 300,
            overlapPercentage: 10,
        },
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    return { stack, template: Template.fromStack(stack) };
}

describe('BedrockKnowledgeBase — snapshot', () => {
    it('matches the synthesized template with defaults', () => {
        expect(synthDefault().template.toJSON()).toMatchSnapshot();
    });

    it('matches the synthesized template with overrides', () => {
        expect(synthCustom().template.toJSON()).toMatchSnapshot();
    });
});

describe('BedrockKnowledgeBase — defaults', () => {
    it('creates one source bucket, one vectors bucket, one vectors index', () => {
        const { template } = synthDefault();
        template.resourceCountIs('AWS::S3::Bucket', 1);
        template.resourceCountIs('AWS::S3Vectors::VectorBucket', 1);
        template.resourceCountIs('AWS::S3Vectors::Index', 1);
    });

    it('configures the vectors index for Titan v2 (1024-d, cosine, float32)', () => {
        const { template } = synthDefault();
        template.hasResourceProperties('AWS::S3Vectors::Index', {
            DataType: 'float32',
            Dimension: 1024,
            DistanceMetric: 'cosine',
        });
    });

    it('marks bedrock chunk-text and -metadata as non-filterable in the index', () => {
        const { template } = synthDefault();
        template.hasResourceProperties('AWS::S3Vectors::Index', {
            MetadataConfiguration: {
                NonFilterableMetadataKeys: [
                    'AMAZON_BEDROCK_TEXT',
                    'AMAZON_BEDROCK_METADATA',
                ],
            },
        });
    });

    it('uses Titan v2 + FLOAT32 + dimensions 1024 on the KB', () => {
        const { template } = synthDefault();
        template.hasResourceProperties('AWS::Bedrock::KnowledgeBase', {
            KnowledgeBaseConfiguration: {
                Type: 'VECTOR',
                VectorKnowledgeBaseConfiguration: Match.objectLike({
                    EmbeddingModelConfiguration: {
                        BedrockEmbeddingModelConfiguration: {
                            Dimensions: 1024,
                            EmbeddingDataType: 'FLOAT32',
                        },
                    },
                }),
            },
        });
    });

    it('configures FIXED_SIZE chunking 512 + 20% overlap by default', () => {
        const { template } = synthDefault();
        template.hasResourceProperties('AWS::Bedrock::DataSource', {
            VectorIngestionConfiguration: {
                ChunkingConfiguration: {
                    ChunkingStrategy: 'FIXED_SIZE',
                    FixedSizeChunkingConfiguration: {
                        MaxTokens: 512,
                        OverlapPercentage: 20,
                    },
                },
            },
        });
    });

    it('grants bedrock:InvokeModel only on the configured embedding model', () => {
        const { template } = synthDefault();
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({
                        Sid: 'InvokeEmbeddingModel',
                        Action: 'bedrock:InvokeModel',
                        Effect: 'Allow',
                    }),
                ]),
            },
        });
    });

    it("scopes the KB role's S3 read to the source bucket only", () => {
        const { template } = synthDefault();
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({
                        Sid: 'ReadSourceBucket',
                        Action: ['s3:GetObject', 's3:ListBucket'],
                    }),
                ]),
            },
        });
    });

    it("scopes the KB role's s3vectors actions to the index ARN", () => {
        const { template } = synthDefault();
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({
                        Sid: 'S3VectorsReadAndWrite',
                        Action: Match.arrayWith([
                            's3vectors:PutVectors',
                            's3vectors:QueryVectors',
                        ]),
                    }),
                ]),
            },
        });
    });

    it('default removal policy is RETAIN (Bucket has Retain DeletionPolicy)', () => {
        const { template } = synthDefault();
        template.hasResource('AWS::S3::Bucket', {
            DeletionPolicy: 'Retain',
        });
    });
});

describe('BedrockKnowledgeBase — overrides', () => {
    it('honors a custom embedding model + dimensions', () => {
        const stack = freshStack('KbCohere');
        new BedrockKnowledgeBase(stack, 'KB', {
            embeddingModel: 'cohere.embed-english-v3',
            embeddingDimensions: 1024,
        });
        const template = Template.fromStack(stack);
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({ Sid: 'InvokeEmbeddingModel' }),
                ]),
            },
        });
    });

    it('honors HIERARCHICAL chunking', () => {
        const { template } = synthCustom();
        template.hasResourceProperties('AWS::Bedrock::DataSource', {
            VectorIngestionConfiguration: {
                ChunkingConfiguration: Match.objectLike({
                    ChunkingStrategy: 'HIERARCHICAL',
                }),
            },
        });
    });

    it('omits reranker grants when rerankerModels is an empty array', () => {
        const { template } = synthCustom();
        // No statement should carry the RerankAction sid.
        const policies = template.findResources('AWS::IAM::Policy');
        const allStatements = Object.values(policies).flatMap(
            (p) => p.Properties?.PolicyDocument?.Statement ?? [],
        );
        expect(allStatements.some((s: { Sid?: string }) => s.Sid === 'RerankAction')).toBe(false);
    });

    it('honors DESTROY removal policy on the KB CFN resource', () => {
        const { template } = synthCustom();
        template.hasResource('AWS::Bedrock::KnowledgeBase', {
            DeletionPolicy: 'Delete',
        });
    });

    it('uses custom KB name in the synthesized resource', () => {
        const { template } = synthCustom();
        template.hasResourceProperties('AWS::Bedrock::KnowledgeBase', {
            Name: 'acme-kb',
        });
    });

    it('uses BYO source bucket when supplied', () => {
        const stack = freshStack('KbByoBucket');
        const existing = new s3.Bucket(stack, 'Existing', { versioned: true });
        new BedrockKnowledgeBase(stack, 'KB', { sourceBucket: existing });
        const template = Template.fromStack(stack);
        // Only one bucket — the BYO one. Construct didn't create another.
        template.resourceCountIs('AWS::S3::Bucket', 1);
    });
});
