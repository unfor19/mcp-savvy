#!/usr/bin/env node
/**
 * End-to-end smoke test for examples/gateway-3lo-mcp.
 *
 * Spawns the built mcp-savvy bridge, performs the MCP `initialize`
 * handshake, lists tools, and asserts the GitHub OpenAPI target
 * surfaced its operations. We deliberately do NOT call a `github_*`
 * tool here: the gateway's first call to GitHub triggers AgentCore
 * Identity's 3LO flow, which opens a browser tab for the user — not
 * something a smoke test can drive unattended. The browser leg is a
 * manual check (point an MCP client at the same env vars).
 *
 * Asserts:
 *   - tools/list returns at least the two declared GitHub
 *     operations (`github_getAuthenticatedUser`, `github_listUserRepos`).
 *
 * Requires that `mcp-savvy --login` has already cached tokens for
 * the same MCP_SAVVY_* env vars. Exits 0 on success, non-zero on
 * any failure.
 */

import {
    awaitId,
    initializeMcp,
    sendFrame,
    shutdownBridge,
    spawnBridge,
} from '../lib.mjs';

async function main() {
    const { child, reader } = spawnBridge();
    try {
        const initResp = await initializeMcp(child, reader, {
            name: 'mcp-savvy-gateway-3lo-smoke',
            version: '0.0.1',
        });
        console.log(`✓ initialize OK (server: ${initResp.result?.serverInfo?.name ?? '?'})`);

        sendFrame(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        const listResp = await awaitId(reader, 2);
        if (listResp.error) throw new Error(`tools/list failed: ${JSON.stringify(listResp.error)}`);
        const tools = listResp.result?.tools ?? [];
        const toolNames = tools.map((t) => t.name);
        const userTool = toolNames.find((n) => n.endsWith('getAuthenticatedUser'));
        const reposTool = toolNames.find((n) => n.endsWith('listUserRepos'));
        if (!userTool || !reposTool) {
            throw new Error(
                `expected getAuthenticatedUser + listUserRepos; got: ${toolNames.join(',')}`,
            );
        }
        console.log(
            `✓ tools/list returned ${tools.length} tool(s); ${userTool} + ${reposTool} present`,
        );
        console.log(
            `\nNote: invoking ${userTool} or ${reposTool} triggers the GitHub`,
        );
        console.log(
            `OAuth browser flow on the first call. Run that step manually from`,
        );
        console.log(
            `your MCP client (Kiro / Claude) — the bridge interceptor handles`,
        );
        console.log(`completion + retry transparently.`);

        console.log(`\nGATEWAY-3LO SMOKE TEST PASSED.`);
    } finally {
        await shutdownBridge(child);
    }
}

main().catch((err) => {
    console.error(`SMOKE TEST FAILED: ${err.message}`);
    process.exit(1);
});
