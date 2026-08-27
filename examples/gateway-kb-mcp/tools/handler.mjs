/**
 * AgentCore Gateway Lambda target for the gateway-kb-mcp demo.
 *
 * The "no-LLM-in-the-loop" KB variant: this Lambda forwards MCP
 * tool calls straight to the Bedrock Agent Runtime KB APIs. No
 * Strands agent, no model invocation inside the Lambda — the host
 * LLM (Kiro / Claude Code / Codex) drives RAG by calling these
 * tools and reasoning over the results itself.
 *
 * Tools exposed:
 *   - kb_retrieve(query, numberOfResults=8)
 *       → bedrock-agent-runtime:Retrieve. Vector search only.
 *         Returns ranked chunks with source URIs, scores, and the
 *         per-chunk metadata (url/title/... from frontmatter).
 *   - kb_retrieve_and_generate(query, numberOfResults=8, decompose=false)
 *       → bedrock-agent-runtime:RetrieveAndGenerate. KB-grounded
 *         answer + citations, generated server-side by Bedrock.
 *         decompose=true enables QUERY_DECOMPOSITION orchestration.
 *
 * Gateway invocation contract (validated live on gateway-lambda-mcp,
 * 2026-05-27):
 *   - `event` is the tool's input arguments map (no envelope).
 *   - `context.clientContext.custom.bedrockAgentCoreToolName` is the
 *     namespaced tool name `${target}___${tool}` (TRIPLE underscore).
 *   - Return any JSON; the gateway forwards it as the tool result.
 */

import {
    BedrockAgentRuntimeClient,
    RetrieveCommand,
    RetrieveAndGenerateCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';

const TARGET_NAME = process.env['GATEWAY_TARGET_NAME'] ?? 'kb';
const KB_ID = process.env['MCP_SAVVY_KB_ID'] ?? '';
const REGION = process.env['AWS_REGION'] ?? 'us-east-1';
const GENERATION_MODEL_ARN = process.env['MCP_SAVVY_KB_GENERATION_MODEL_ARN'] ?? '';
const DEFAULT_RESULTS = 8;
const MAX_RESULTS = 20;
const MAX_QUERY_CHARS = 4096;
const MAX_CONTENT_CHARS = 8192;
const MAX_ANSWER_CHARS = 16_384;
const MAX_METADATA_CHARS = 4096;

/** Triple-underscore delimiter between target name and tool name. */
const DELIMITER = '___';

let client = new BedrockAgentRuntimeClient({ region: REGION });

/** Replace the runtime client in tests. */
export function setRuntimeClientForTest(runtimeClient) {
    client = runtimeClient;
}

/** Normalize and validate shared KB inputs before any billable request. */
function parseInputs(args) {
    const query = typeof args?.query === 'string' ? args.query.trim() : '';
    const rawResults = args?.numberOfResults ?? DEFAULT_RESULTS;
    if (!query || query.length > MAX_QUERY_CHARS) {
        return {
            error: 'invalid_input',
            message: `query must contain 1-${MAX_QUERY_CHARS} characters.`,
        };
    }
    if (!Number.isInteger(rawResults) || rawResults < 1 || rawResults > MAX_RESULTS) {
        return {
            error: 'invalid_input',
            message: `numberOfResults must be an integer from 1-${MAX_RESULTS}.`,
        };
    }
    return { query, numberOfResults: rawResults };
}

/** Return a bounded string while preserving an explicit truncation marker. */
function boundedText(value, maxChars) {
    const text = typeof value === 'string' ? value : '';
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\u2026`;
}

/** Keep arbitrary provider objects below the public response budget. */
function boundedObject(value) {
    const serialized = JSON.stringify(value ?? {});
    return serialized.length <= MAX_METADATA_CHARS
        ? value ?? {}
        : { truncated: true };
}

/** Strip the AgentCore Gateway target-name prefix from a tool name. */
function stripPrefix(toolName) {
    const prefix = `${TARGET_NAME}${DELIMITER}`;
    return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}

/** kb_retrieve — vector search; returns ranked chunks. */
async function kbRetrieve(args) {
    const input = parseInputs(args);
    if ('error' in input) return input;

    const resp = await client.send(
        new RetrieveCommand({
            knowledgeBaseId: KB_ID,
            retrievalQuery: { text: input.query },
            retrievalConfiguration: {
                vectorSearchConfiguration: { numberOfResults: input.numberOfResults },
            },
        }),
    );
    const results = (resp.retrievalResults ?? []).slice(0, MAX_RESULTS).map((r) => ({
        content: boundedText(r.content?.text, MAX_CONTENT_CHARS),
        score: r.score,
        location: boundedObject(r.location),
        metadata: boundedObject(r.metadata),
    }));
    return { results, count: results.length };
}

/** kb_retrieve_and_generate — KB-grounded answer with citations. */
async function kbRetrieveAndGenerate(args) {
    const input = parseInputs(args);
    if ('error' in input) return input;
    const decompose = args?.decompose === true;
    if (!GENERATION_MODEL_ARN) {
        return {
            error: 'misconfigured',
            message: 'MCP_SAVVY_KB_GENERATION_MODEL_ARN is not set on the Lambda.',
        };
    }

    const kbConfig = {
        knowledgeBaseId: KB_ID,
        modelArn: GENERATION_MODEL_ARN,
        retrievalConfiguration: {
            vectorSearchConfiguration: { numberOfResults: input.numberOfResults },
        },
    };
    if (decompose) {
        kbConfig.orchestrationConfiguration = {
            queryTransformationConfiguration: { type: 'QUERY_DECOMPOSITION' },
        };
    }
    const resp = await client.send(
        new RetrieveAndGenerateCommand({
            input: { text: input.query },
            retrieveAndGenerateConfiguration: {
                type: 'KNOWLEDGE_BASE',
                knowledgeBaseConfiguration: kbConfig,
            },
        }),
    );
    const answer = boundedText(resp.output?.text, MAX_ANSWER_CHARS);
    const citations = (resp.citations ?? []).slice(0, MAX_RESULTS).map((c) => ({
        text: boundedText(c.generatedResponsePart?.textResponsePart?.text, MAX_CONTENT_CHARS),
        sources: (c.retrievedReferences ?? []).slice(0, MAX_RESULTS).map((ref) => ({
            content: boundedText(ref.content?.text, MAX_CONTENT_CHARS),
            location: boundedObject(ref.location),
            metadata: boundedObject(ref.metadata),
        })),
    }));
    return { answer, citations };
}

/** Lambda entry point invoked by the AgentCore Gateway. */
export const handler = async (event, context) => {
    if (!KB_ID) {
        return { error: 'misconfigured', message: 'MCP_SAVVY_KB_ID is not set on the Lambda.' };
    }
    const cc = context?.clientContext ?? {};
    const custom = cc.custom ?? cc.Custom ?? {};
    const fullName = custom.bedrockAgentCoreToolName ?? '';
    const toolName = stripPrefix(fullName);
    try {
        switch (toolName) {
            case 'kb_retrieve':
                return await kbRetrieve(event);
            case 'kb_retrieve_and_generate':
                return await kbRetrieveAndGenerate(event);
            default:
                return {
                    error: 'unknown_tool',
                    message: `Tool "${fullName}" is not implemented by this Lambda.`,
                };
        }
    } catch (err) {
        console.error('gateway KB request failed', {
            toolName,
            errorType: err instanceof Error ? err.name : 'UnknownError',
            requestId: context?.awsRequestId,
        });
        return {
            error: 'runtime_error',
            message: 'The knowledge-base request could not be completed.',
        };
    }
};
