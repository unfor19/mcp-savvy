#!/usr/bin/env node
/**
 * End-to-end smoke test for examples/kb-mcp (agentic flavor).
 *
 * Loads the verification queries from
 * `examples/_shared/kb-corpus/queries.json` and drives them through
 * the bridge against the deployed `ask` tool. Asserts every
 * expected_substring appears (case-insensitive) in the agent's
 * answer. Exits 0 on success, non-zero if any query fails.
 *
 * Requires that `mcp-savvy --login` has cached tokens and that the
 * KB ingestion job has completed (so the agent has content to
 * retrieve).
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

/** Number of queries to actually send. Defaults to "all" via env var. */
const LIMIT = Number.parseInt(process.env.MCP_SAVVY_KB_SMOKE_LIMIT ?? '0', 10);
/** Per-call timeout. KB lookups + Sonnet generation can take 30-60s. */
const CALL_TIMEOUT_MS = Number.parseInt(
    process.env.MCP_SAVVY_KB_SMOKE_TIMEOUT_MS ?? '120000',
    10,
);

/** Pretty-print first N chars of a string. */
function preview(s, n = 200) {
    if (typeof s !== 'string') return JSON.stringify(s);
    return s.length > n ? `${s.slice(0, n)}…` : s;
}

async function main() {
    const queriesRaw = await readFile(QUERIES_PATH, 'utf8');
    const { queries } = JSON.parse(queriesRaw);
    if (!Array.isArray(queries) || queries.length === 0) {
        throw new Error(`no queries in ${QUERIES_PATH}`);
    }
    const subset = LIMIT > 0 ? queries.slice(0, LIMIT) : queries;
    console.log(`Driving ${subset.length} verification quer${subset.length === 1 ? 'y' : 'ies'}.`);

    const { child, reader } = spawnBridge();
    const failures = [];
    try {
        const init = await initializeMcp(child, reader, {
            name: 'mcp-savvy-kb-smoke',
            version: '0.0.1',
        });
        console.log(`✓ initialize OK (server: ${init.result?.serverInfo?.name ?? '?'})`);

        sendFrame(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        const list = await awaitId(reader, 2);
        if (list.error) throw new Error(`tools/list failed: ${JSON.stringify(list.error)}`);
        const tools = list.result?.tools ?? [];
        const ask = tools.find((t) => t.name === 'ask');
        if (!ask) {
            throw new Error(`ask tool missing; got: ${tools.map((t) => t.name).join(',')}`);
        }
        console.log(`✓ tools/list returned ${tools.length} tool(s); ask present`);

        for (let i = 0; i < subset.length; i += 1) {
            const q = subset[i];
            const callId = 100 + i;
            const expected = q.expected_substrings ?? [];
            const sourceUrl = q.source_url ?? '';
            sendFrame(child, {
                jsonrpc: '2.0',
                id: callId,
                method: 'tools/call',
                params: {
                    name: 'ask',
                    arguments: { prompt: q.question },
                },
            });
            const resp = await awaitId(reader, callId, CALL_TIMEOUT_MS);
            if (resp.error) {
                failures.push({
                    question: q.question,
                    reason: `ask error: ${JSON.stringify(resp.error)}`,
                });
                console.log(`  ✗ ${q.question}`);
                continue;
            }
            const env = extractToolResult(resp);
            const answer = (env?.answer ?? '').toString().toLowerCase();
            const sources = (env?.sources ?? []).map((s) => s?.url ?? '');
            const missing = expected.filter(
                (sub) => !answer.includes(sub.toLowerCase()),
            );
            const cited = sourceUrl
                ? sources.some((url) => typeof url === 'string' && url.includes(sourceUrl))
                : true;

            if (missing.length === 0 && cited) {
                console.log(`  ✓ ${q.question}`);
                console.log(`     answer: ${preview(env?.answer ?? '')}`);
            } else {
                failures.push({
                    question: q.question,
                    missing,
                    cited,
                    sourceUrl,
                    sources,
                    confidence: env?.confidence,
                    answer: env?.answer,
                });
                console.log(`  ✗ ${q.question}`);
                if (missing.length > 0) {
                    console.log(`     missing substrings: ${JSON.stringify(missing)}`);
                }
                if (!cited) {
                    console.log(`     expected source url to include: ${sourceUrl}`);
                    console.log(`     got sources: ${JSON.stringify(sources)}`);
                }
                console.log(`     answer: ${preview(env?.answer ?? '')}`);
            }
        }
    } finally {
        await shutdownBridge(child);
    }

    if (failures.length > 0) {
        console.log(
            `\n✗ kb smoke failed: ${failures.length}/${subset.length} quer${failures.length === 1 ? 'y' : 'ies'} did not pass.`,
        );
        process.exit(1);
    }
    console.log(`\n✓ kb smoke passed: ${subset.length}/${subset.length}.`);
}

main().catch((err) => {
    console.error(`SMOKE TEST FAILED: ${err.stack ?? err.message ?? err}`);
    process.exit(1);
});
