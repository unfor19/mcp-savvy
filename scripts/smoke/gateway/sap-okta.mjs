#!/usr/bin/env node
/**
 * Read-only discovery smoke for the Okta-gated AWS for SAP MCP Gateway.
 *
 * This proves Okta login, MCP initialization, and cached SAP tool discovery.
 * It rejects known write capabilities and avoids SAP data calls because safe
 * arguments depend on the operator's allowlisted OData services.
 */

import {
    awaitId,
    initializeMcp,
    sendFrame,
    shutdownBridge,
    spawnBridge,
} from '../lib.mjs';

const EXPECTED_READ_TOOLS = [
    'find_sap_services',
    'get_metadata',
    'odata_read',
    'odata_count',
];
const FORBIDDEN_WRITE_TOOLS = [
    'odata_create',
    'odata_update',
    'odata_delete',
    'odata_function_import',
];

async function main() {
    const { child, reader } = spawnBridge();
    try {
        const initResp = await initializeMcp(child, reader, {
            name: 'mcp-savvy-gateway-sap-okta-smoke',
            version: '0.0.1',
        });
        console.log(`✓ initialize OK (server: ${initResp.result?.serverInfo?.name ?? '?'})`);

        sendFrame(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        const listResp = await awaitId(reader, 2);
        if (listResp.error) throw new Error(`tools/list failed: ${JSON.stringify(listResp.error)}`);

        const tools = listResp.result?.tools ?? [];
        const names = tools.map((tool) => tool.name);
        const missing = EXPECTED_READ_TOOLS.filter(
            (expected) => !names.some((name) => name.endsWith(expected)),
        );
        if (missing.length > 0) {
            throw new Error(`missing ${missing.join(', ')}; got: ${names.join(', ')}`);
        }
        const exposedWrites = FORBIDDEN_WRITE_TOOLS.filter(
            (forbidden) => names.some((name) => name.endsWith(forbidden)),
        );
        if (exposedWrites.length > 0) {
            throw new Error(`write tools exposed by SAP MCP target: ${exposedWrites.join(', ')}`);
        }

        console.log(`✓ tools/list returned ${tools.length} tool(s); read tools present, writes absent`);
        console.log('Note: this smoke does not call SAP. Run the README acceptance steps.');
        console.log('\nGATEWAY-SAP-OKTA SMOKE TEST PASSED.');
    } finally {
        await shutdownBridge(child);
    }
}

main().catch((error) => {
    console.error(`SMOKE TEST FAILED: ${error.message}`);
    process.exit(1);
});
