#!/usr/bin/env node
/**
 * End-to-end smoke test for examples/minimal-mcp.
 *
 * Spawns the built mcp-savvy bridge, performs the MCP `initialize`
 * handshake, lists tools, and invokes the `echo` tool. Asserts the
 * round-trip returns the value we sent. Exits 0 on success, non-zero
 * on any failure.
 *
 * Requires that `mcp-savvy --login` has already cached tokens for
 * the same MCP_SAVVY_* env vars.
 */

import {
    awaitId,
    initializeMcp,
    sendFrame,
    shutdownBridge,
    spawnBridge,
} from './lib.mjs';

async function main() {
    const { child, reader } = spawnBridge();
    try {
        const initResp = await initializeMcp(child, reader, {
            name: 'mcp-savvy-smoke',
            version: '0.0.1',
        });
        console.log(`✓ initialize OK (server: ${initResp.result?.serverInfo?.name ?? '?'})`);

        sendFrame(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        const listResp = await awaitId(reader, 2);
        if (listResp.error) throw new Error(`tools/list failed: ${JSON.stringify(listResp.error)}`);
        const tools = listResp.result?.tools ?? [];
        const echo = tools.find((t) => t.name === 'echo');
        if (!echo) {
            throw new Error(`echo tool missing; got: ${tools.map((t) => t.name).join(',')}`);
        }
        console.log(`✓ tools/list returned ${tools.length} tool(s); echo present`);

        const probe = `mcp-savvy round-trip ${new Date().toISOString()}`;
        sendFrame(child, {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'echo', arguments: { message: probe } },
        });
        const callResp = await awaitId(reader, 3);
        if (callResp.error) throw new Error(`echo failed: ${JSON.stringify(callResp.error)}`);
        const text = callResp.result?.content
            ?.map((c) => (c.type === 'text' ? c.text : ''))
            .join('');
        if (!text || !text.includes(probe)) {
            throw new Error(`echo returned unexpected content: ${JSON.stringify(callResp.result)}`);
        }
        console.log(`✓ echo round-trip succeeded`);
        console.log(`\nSMOKE TEST PASSED.`);
    } finally {
        await shutdownBridge(child);
    }
}

main().catch((err) => {
    console.error(`SMOKE TEST FAILED: ${err.message}`);
    process.exit(1);
});
