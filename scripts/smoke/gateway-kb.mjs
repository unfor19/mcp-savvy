#!/usr/bin/env node
/**
 * End-to-end smoke test for examples/gateway-kb-mcp.
 *
 * Drives the verification queries from
 * `examples/_shared/kb-corpus/queries.json` through the gateway's
 * `kb___kb_retrieve` tool via the bridge, and asserts every
 * expected_substring appears (case-insensitive) somewhere in the
 * returned chunks. This validates the no-LLM path: Gateway →
 * Lambda → bedrock-agent-runtime:Retrieve.
 *
 * Unlike the agentic kb-mcp smoke (which asserts on a generated
 * answer), this asserts on raw retrieved chunks — there's no model
 * in the loop to phrase an answer, so we check retrieval directly.
 *
 * Requires `mcp-savvy --login` to have cached tokens and the KB
 * ingestion job to have completed.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    awaitId,
    extractToolResult,
    initializeMcp,
    sendFrame,
    shutdownBridge,
    spawnBridge,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUERIES_PATH = resolve(
    HERE,
    '..',
    '..',
    'examples',
    '_shared',
    'kb-corpus',
    'queries.json',
);

const TARGET = process.env.MCP_SAVVY_KB_TARGET ?? 'kb';
const RETRIEVE_TOOL = `${TARGET}___kb_retrieve`;
const LIMIT = Number.parseInt(process.env.MCP_SAVVY_KB_SMOKE_LIMIT ?? '0', 10);
const CALL_TIMEOUT_MS = Number.parseInt(
    process.env.MCP_SAVVY_KB_SMOKE_TIMEOUT_MS ?? '60000',
    10,
);

/** Flatten retrieved chunks into one lowercased haystack. */
function chunksToHaystack(result) {
    const results = result?.results ?? [];
    return results
        .map((r) => `${r.content ?? ''} ${JSON.stringify(r.metadata ?? {})}`)
        .join(' ')
        .toLowerCase();
}

async function main() {
    const { queries } = JSON.parse(await readFile(QUERIES_PATH, 'utf8'));
    if (!Array.isArray(queries) || queries.length === 0) {
        throw new Error(`no queries in ${QUERIES_PATH}`);
    }
    const subset = LIMIT > 0 ? queries.slice(0, LIMIT) : queries;
    console.log(`Driving ${subset.length} quer${subset.length === 1 ? 'y' : 'ies'} through ${RETRIEVE_TOOL}.`);

    const { child, reader } = spawnBridge();
    const failures = [];
    try {
        const init = await initializeMcp(child, reader, {
            name: 'mcp-savvy-gateway-kb-smoke',
            version: '0.0.1',
        });
        console.log(`✓ initialize OK (server: ${init.result?.serverInfo?.name ?? '?'})`);

        sendFrame(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        const list = await awaitId(reader, 2);
        if (list.error) throw new Error(`tools/list failed: ${JSON.stringify(list.error)}`);
        const tools = (list.result?.tools ?? []).map((t) => t.name);
        if (!tools.includes(RETRIEVE_TOOL)) {
            throw new Error(`${RETRIEVE_TOOL} missing; got: ${tools.join(',')}`);
        }
        console.log(`✓ tools/list returned ${tools.length} tool(s); ${RETRIEVE_TOOL} present`);

        for (let i = 0; i < subset.length; i += 1) {
            const q = subset[i];
            const callId = 100 + i;
            const expected = q.expected_substrings ?? [];
            sendFrame(child, {
                jsonrpc: '2.0',
                id: callId,
                method: 'tools/call',
                params: {
                    name: RETRIEVE_TOOL,
                    arguments: { query: q.question, numberOfResults: 8 },
                },
            });
            const resp = await awaitId(reader, callId, CALL_TIMEOUT_MS);
            if (resp.error) {
                failures.push({ question: q.question, reason: JSON.stringify(resp.error) });
                console.log(`  ✗ ${q.question}`);
                continue;
            }
            const haystack = chunksToHaystack(extractToolResult(resp));
            const missing = expected.filter((s) => !haystack.includes(s.toLowerCase()));
            if (missing.length === 0) {
                console.log(`  ✓ ${q.question}`);
            } else {
                failures.push({ question: q.question, missing });
                console.log(`  ✗ ${q.question}`);
                console.log(`     missing: ${JSON.stringify(missing)}`);
            }
        }
    } finally {
        await shutdownBridge(child);
    }

    if (failures.length > 0) {
        console.log(`\n✗ gateway-kb smoke failed: ${failures.length}/${subset.length}.`);
        process.exit(1);
    }
    console.log(`\n✓ gateway-kb smoke passed: ${subset.length}/${subset.length}.`);
}

main().catch((err) => {
    console.error(`SMOKE TEST FAILED: ${err.stack ?? err.message ?? err}`);
    process.exit(1);
});
