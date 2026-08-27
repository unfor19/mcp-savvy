/** Security boundary tests for the gateway KB Lambda target. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();

vi.mock('@aws-sdk/client-bedrock-agent-runtime', () => ({
    BedrockAgentRuntimeClient: class {},
    RetrieveCommand: class {
        constructor(input) {
            this.input = input;
        }
    },
    RetrieveAndGenerateCommand: class {
        constructor(input) {
            this.input = input;
        }
    },
}));

const originalKbId = process.env.MCP_SAVVY_KB_ID;
process.env.MCP_SAVVY_KB_ID = 'kb-test';
const { handler, setRuntimeClientForTest } = await import('./handler.mjs');

const context = (toolName) => ({
    awsRequestId: 'request-1',
    clientContext: { custom: { bedrockAgentCoreToolName: `kb___${toolName}` } },
});

beforeEach(() => {
    send.mockReset();
    setRuntimeClientForTest({ send });
});

describe('gateway KB handler', () => {
    it.each([
        [{ query: '' }, 'query'],
        [{ query: 'x'.repeat(4097) }, 'query'],
        [{ query: 'ok', numberOfResults: 0 }, 'numberOfResults'],
        [{ query: 'ok', numberOfResults: 21 }, 'numberOfResults'],
        [{ query: 'ok', numberOfResults: 1.5 }, 'numberOfResults'],
    ])('rejects invalid inputs before calling the provider', async (event, field) => {
        const result = await handler(event, context('kb_retrieve'));
        expect(result).toMatchObject({ error: 'invalid_input' });
        expect(result.message).toContain(field);
        expect(send).not.toHaveBeenCalled();
    });

    it('applies the bounded default and truncates provider-controlled output', async () => {
        send.mockResolvedValueOnce({
            retrievalResults: [{
                content: { text: 'x'.repeat(9000) },
                metadata: { value: 'm'.repeat(5000) },
            }],
        });
        const result = await handler({ query: ' hello ' }, context('kb_retrieve'));
        expect(send.mock.calls[0][0].input).toMatchObject({
            retrievalQuery: { text: 'hello' },
            retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: 8 } },
        });
        expect(result.results[0].content.length).toBe(8193);
        expect(result.results[0].metadata).toEqual({ truncated: true });
    });

    it('returns and logs only stable error metadata', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        send.mockRejectedValueOnce(new Error('private-provider-canary'));
        const result = await handler({ query: 'hello' }, context('kb_retrieve'));
        expect(result).toEqual({
            error: 'runtime_error',
            message: 'The knowledge-base request could not be completed.',
        });
        expect(JSON.stringify(logged.mock.calls)).not.toContain('private-provider-canary');
    });
});

if (originalKbId === undefined) delete process.env.MCP_SAVVY_KB_ID;
else process.env.MCP_SAVVY_KB_ID = originalKbId;
