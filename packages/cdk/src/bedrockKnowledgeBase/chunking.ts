/**
 * Translate a `ChunkingConfig` into the CFN shape Bedrock KB
 * expects. Pulled out of the construct so the strategy logic and
 * the resource composition stay separately testable.
 */

import type * as bedrock from 'aws-cdk-lib/aws-bedrock';
import type { ChunkingConfig } from './types.js';

/**
 * Build the CFN chunking-configuration block for a Bedrock KB
 * data source. The strategy `'FIXED_SIZE'` is the default per
 * `ResolvedKbConfig` — it fits within the S3 Vectors 2KB
 * filterable-metadata budget that hierarchical chunking can
 * exceed on long-form markdown.
 */
export function buildChunkingCfn(
    chunking: Required<ChunkingConfig>,
): bedrock.CfnDataSource.ChunkingConfigurationProperty {
    if (chunking.strategy === 'NONE') {
        return { chunkingStrategy: 'NONE' };
    }
    if (chunking.strategy === 'HIERARCHICAL') {
        return {
            chunkingStrategy: 'HIERARCHICAL',
            hierarchicalChunkingConfiguration: {
                levelConfigurations: [
                    { maxTokens: chunking.maxTokens * 2 },
                    { maxTokens: chunking.maxTokens },
                ],
                overlapTokens: Math.round(
                    chunking.maxTokens * (chunking.overlapPercentage / 100),
                ),
            },
        };
    }
    if (chunking.strategy === 'SEMANTIC') {
        return {
            chunkingStrategy: 'SEMANTIC',
            semanticChunkingConfiguration: {
                maxTokens: chunking.maxTokens,
                bufferSize: 0,
                breakpointPercentileThreshold: 95,
            },
        };
    }
    return {
        chunkingStrategy: 'FIXED_SIZE',
        fixedSizeChunkingConfiguration: {
            maxTokens: chunking.maxTokens,
            overlapPercentage: chunking.overlapPercentage,
        },
    };
}
