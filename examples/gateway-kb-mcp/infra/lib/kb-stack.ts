import * as cdk from 'aws-cdk-lib';
import { BedrockKnowledgeBase } from '@mcp-savvy/cdk';
import { Construct } from 'constructs';

/** Inputs for the gateway-kb-mcp KB stack. */
export interface KbStackProps extends cdk.StackProps {
    /** Override the embedding model. Defaults to Titan v2 1024-d. */
    readonly embeddingModel?: string;
    /** Override the default 1024 vector dimensions. */
    readonly embeddingDimensions?: number;
    /** RemovalPolicy for the KB resources. Defaults to RETAIN. */
    readonly removalPolicy?: cdk.RemovalPolicy;
}

/**
 * Bedrock Knowledge Base for the gateway-kb-mcp demo. Identical
 * construct usage to `examples/kb-mcp` — both examples front the
 * same `BedrockKnowledgeBase`. The only difference is what calls
 * it: kb-mcp runs a Strands agent; gateway-kb-mcp forwards from a
 * Lambda target with no model in the loop.
 */
export class KbStack extends cdk.Stack {
    public readonly kb: BedrockKnowledgeBase;

    constructor(scope: Construct, id: string, props: KbStackProps = {}) {
        super(scope, id, props);

        const kbProps: {
            knowledgeBaseName: string;
            knowledgeBaseDescription: string;
            embeddingModel?: string;
            embeddingDimensions?: number;
            removalPolicy?: cdk.RemovalPolicy;
        } = {
            knowledgeBaseName: 'mcp-savvy-gateway-kb-demo',
            knowledgeBaseDescription:
                'mcp-savvy gateway-kb-mcp demo: meirg.co.il posts indexed by Bedrock KB.',
        };
        if (props.embeddingModel) kbProps.embeddingModel = props.embeddingModel;
        if (props.embeddingDimensions !== undefined) {
            kbProps.embeddingDimensions = props.embeddingDimensions;
        }
        if (props.removalPolicy) kbProps.removalPolicy = props.removalPolicy;

        this.kb = new BedrockKnowledgeBase(this, 'KB', kbProps);

        new cdk.CfnOutput(this, 'KnowledgeBaseId', {
            value: this.kb.knowledgeBaseId,
            description: 'Bedrock KB id — used by the gateway Lambda + smoke tests',
        });
        new cdk.CfnOutput(this, 'KnowledgeBaseArn', {
            value: this.kb.knowledgeBaseArn,
            description: 'Bedrock KB ARN — used to scope IAM grants',
        });
        new cdk.CfnOutput(this, 'DataSourceId', {
            value: this.kb.dataSourceId,
            description: 'Data-source id — used by the kb-ingest script',
        });
        new cdk.CfnOutput(this, 'SourceBucketName', {
            value: this.kb.sourceBucket.bucketName,
            description: 'S3 source bucket — used by the kb-sync script',
        });

        cdk.Tags.of(this).add('Project', 'mcp-savvy-gateway-kb-demo');
    }
}
