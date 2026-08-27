#!/usr/bin/env node
/**
 * End-to-end smoke test for examples/gateway-lambda-mcp.
 *
 * Spawns the built mcp-savvy bridge, performs the MCP `initialize`
 * handshake, lists tools, and invokes the gateway's Lambda-backed
 * tools. Asserts:
 *   - tools/list returns at least one of `tools_getCurrentTime` and
 *     `tools_summarizeText` (the gateway prefixes target name to
 *     each tool name on the wire).
 *   - tools/call on `tools_getCurrentTime` returns an ISO timestamp.
 *   - tools/call on `tools_summarizeText` truncates as specified.
 *
 * Requires that `mcp-savvy --login` has already cached tokens for
 * the same MCP_SAVVY_* env vars. Exits 0 on success, non-zero on
 * any failure.
 */

import {
    awaitId,
    extractToolResult,
    initializeMcp,
    sendFrame,
    shutdownBridge,
    spawnBridge,
} from '../lib.mjs';

async function main() {
    const { child, reader } = spawnBridge();
    try {
        const initResp = await initializeMcp(child, reader, {
            name: 'mcp-savvy-gateway-smoke',
            version: '0.0.1',
        });
        console.log(`✓ initialize OK (server: ${initResp.result?.serverInfo?.name ?? '?'})`);

        sendFrame(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        const listResp = await awaitId(reader, 2);
        if (listResp.error) throw new Error(`tools/list failed: ${JSON.stringify(listResp.error)}`);
        const tools = listResp.result?.tools ?? [];
        const toolNames = tools.map((t) => t.name);
        const timeTool = toolNames.find((n) => n.endsWith('getCurrentTime'));
        const summTool = toolNames.find((n) => n.endsWith('summarizeText'));
        if (!timeTool || !summTool) {
            throw new Error(`expected getCurrentTime + summarizeText; got: ${toolNames.join(',')}`);
        }
        console.log(
            `✓ tools/list returned ${tools.length} tool(s); ${timeTool} + ${summTool} present`,
        );

        sendFrame(child, {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: timeTool, arguments: {} },
        });
        const timeResp = await awaitId(reader, 3);
        if (timeResp.error) throw new Error(`${timeTool} failed: ${JSON.stringify(timeResp.error)}`);
        const timeResult = extractToolResult(timeResp);
        if (!timeResult?.iso || !/\d{4}-\d{2}-\d{2}T/.test(timeResult.iso)) {
            throw new Error(
                `${timeTool} returned no ISO timestamp: ${JSON.stringify(timeResp.result)}`,
            );
        }
        console.log(`✓ ${timeTool} round-trip succeeded (iso=${timeResult.iso})`);

        const probe = 'The quick brown fox jumps over the lazy dog repeatedly until the day is done.';
        sendFrame(child, {
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: { name: summTool, arguments: { text: probe, maxChars: 20 } },
        });
        const summResp = await awaitId(reader, 4);
        if (summResp.error) throw new Error(`${summTool} failed: ${JSON.stringify(summResp.error)}`);
        const summResult = extractToolResult(summResp);
        if (!summResult || typeof summResult.summary !== 'string' || !summResult.truncated) {
            throw new Error(
                `${summTool} returned unexpected payload: ${JSON.stringify(summResp.result)}`,
            );
        }
        console.log(
            `✓ ${summTool} round-trip succeeded (truncated=${summResult.truncated}, wordCount=${summResult.wordCount})`,
        );

        console.log(`\nGATEWAY-LAMBDA SMOKE TEST PASSED.`);
    } finally {
        await shutdownBridge(child);
    }
}

main().catch((err) => {
    console.error(`SMOKE TEST FAILED: ${err.message}`);
    process.exit(1);
});
