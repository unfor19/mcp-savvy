import { aws_bedrockagentcore as agentcore } from 'aws-cdk-lib';

/**
 * Inline tool schema for the gateway-kb-mcp Lambda target: the two
 * KB tools the host LLM calls to drive RAG itself. Pulled out of
 * the stack so the gateway stack stays focused on wiring.
 */
export function buildKbToolSchema(): agentcore.ToolDefinition[] {
    return [
        {
            name: 'kb_retrieve',
            description:
                'Search the Bedrock Knowledge Base by vector similarity. ' +
                'Returns ranked text chunks with source URIs, scores, and ' +
                'metadata (url/title/...). Use this when you want raw context ' +
                'to reason over yourself. For a fully-grounded answer with ' +
                'citations generated server-side, use kb_retrieve_and_generate.',
            inputSchema: {
                type: agentcore.SchemaDefinitionType.OBJECT,
                properties: {
                    query: {
                        type: agentcore.SchemaDefinitionType.STRING,
                        description: 'Natural-language question or keyword phrase (1-4096 characters).',
                    },
                    numberOfResults: {
                        type: agentcore.SchemaDefinitionType.INTEGER,
                        description:
                            'How many chunks to return (integer 1-20). Optional; defaults to 8.',
                    },
                },
                required: ['query'],
            },
        },
        {
            name: 'kb_retrieve_and_generate',
            description:
                'Ask the Bedrock Knowledge Base a question and get a grounded ' +
                'natural-language answer with inline citations, generated ' +
                'server-side by Bedrock. Pass decompose=true to enable ' +
                'QUERY_DECOMPOSITION for multi-fact questions (slower, better ' +
                'recall). Returns { answer, citations: [{ text, sources }] }.',
            inputSchema: {
                type: agentcore.SchemaDefinitionType.OBJECT,
                properties: {
                    query: {
                        type: agentcore.SchemaDefinitionType.STRING,
                        description: 'Natural-language question (1-4096 characters).',
                    },
                    numberOfResults: {
                        type: agentcore.SchemaDefinitionType.INTEGER,
                        description:
                            'How many chunks to retrieve before generating. ' +
                            'Optional integer from 1-20; defaults to 8.',
                    },
                    decompose: {
                        type: agentcore.SchemaDefinitionType.BOOLEAN,
                        description:
                            'Enable QUERY_DECOMPOSITION orchestration for ' +
                            'multi-fact questions. Optional; defaults to false.',
                    },
                },
                required: ['query'],
            },
        },
    ];
}
