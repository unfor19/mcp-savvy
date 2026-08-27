/**
 * Minimal MCP JSON-RPC dispatcher for the chatgpt-app-mcp Lambda.
 *
 * We hand-roll the MCP Streamable HTTP server side rather than
 * pulling in `@modelcontextprotocol/sdk`. The wire surface needed
 * for this demo is small (initialize + tools/list + tools/call +
 * resources/list + resources/read) and the dependency-light path
 * keeps the Lambda asset banking-grade auditable.
 *
 * Tool implementations live in `./tools/*.mjs` and accept a
 * dependency-injected `context` so unit tests can stub the DDB and
 * audit modules.
 */

import {
    TOOL_DEFINITION as STATUS_TOOL_DEFINITION,
    TOOL_NAME as STATUS_TOOL_NAME,
    getCreditBalanceStatus,
} from './tools/getCreditBalanceStatus.mjs';
import {
    TOOL_DEFINITION as ACTUAL_TOOL_DEFINITION,
    TOOL_NAME as ACTUAL_TOOL_NAME,
    getCreditBalanceActual,
} from './tools/getCreditBalanceActual.mjs';
import {
    TOOL_DEFINITION as LIST_BRANCHES_TOOL_DEFINITION,
    TOOL_NAME as LIST_BRANCHES_TOOL_NAME,
    listBranches,
} from './tools/listBranches.mjs';
import {
    TOOL_DEFINITION as FIND_NEAREST_TOOL_DEFINITION,
    TOOL_NAME as FIND_NEAREST_TOOL_NAME,
    findNearestBranches,
} from './tools/findNearestBranches.mjs';
import { WIDGETS, lookupWidget } from './widgetUri.mjs';

const SERVER_NAME = 'mcp-savvy-chatgpt-app';
const SERVER_VERSION = '0.2.0';
const PROTOCOL_VERSION = '2025-06-18';

/**
 * Tools advertised by `tools/list`. Order is stable.
 *   - balance status: model-visible — shows the secure widget pointer.
 *   - balance actual: widget-only (`_meta.ui.visibility: ["app"]`).
 *   - list branches: model-visible — public Israel branch directory.
 *   - find nearest branches: model-visible — distance-ranked, reads
 *     `_meta["openai/userLocation"]` from the request.
 */
const TOOL_DEFINITIONS = [
    STATUS_TOOL_DEFINITION,
    ACTUAL_TOOL_DEFINITION,
    LIST_BRANCHES_TOOL_DEFINITION,
    FIND_NEAREST_TOOL_DEFINITION,
];

/**
 * Resources advertised by `resources/list`. The widget bundles
 * carry Apps SDK metadata so ChatGPT renders them in bordered
 * cards. CSP is empty — neither widget fetches anything; both read
 * the tool result delivered by the host.
 */
const RESOURCE_CSP = Object.freeze({
    connectDomains: [],
    resourceDomains: [],
});
const RESOURCE_DEFINITIONS = [
    {
        uri: WIDGETS.balance.uri,
        name: 'Credit balance widget',
        description:
            'Sandboxed iframe that calls `get_credit_balance_actual` via ' +
            '`window.openai.callTool` and renders the result client-side. The actual ' +
            'amount lives in the tool result `_meta` only; the model never sees it.',
        mimeType: 'text/html+skybridge',
    },
    {
        uri: WIDGETS.branches.uri,
        name: 'Branches list widget',
        description:
            'Sandboxed iframe that renders the `list_branches` result as a card with ' +
            'today\'s open/closed status per row and a click-through directions link.',
        mimeType: 'text/html+skybridge',
    },
];

/** JSON-RPC 2.0 success envelope. */
function rpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}

/** JSON-RPC 2.0 error envelope. */
function rpcError(id, code, message, data) {
    const error = data === undefined ? { code, message } : { code, message, data };
    return { jsonrpc: '2.0', id, error };
}

/** Dispatch a single MCP JSON-RPC request and return the response envelope. */
export async function dispatch(request, context) {
    const { id, method, params } = request ?? {};
    if (request?.jsonrpc !== '2.0') {
        return rpcError(id ?? null, -32600, 'Invalid Request: jsonrpc must be "2.0"');
    }
    if (typeof method !== 'string' || method.length === 0) {
        return rpcError(id ?? null, -32600, 'Invalid Request: method is required');
    }

    try {
        switch (method) {
            case 'initialize':
                return rpcResult(id, handleInitialize(params));
            case 'tools/list':
                return rpcResult(id, { tools: TOOL_DEFINITIONS });
            case 'tools/call':
                return rpcResult(id, await handleToolsCall(params, context));
            case 'resources/list':
                return rpcResult(id, { resources: RESOURCE_DEFINITIONS });
            case 'resources/read':
                return rpcResult(id, handleResourcesRead(params));
            case 'ping':
                return rpcResult(id, {});
            case 'notifications/initialized':
                // Notifications carry no id and expect no response.
                return null;
            default:
                return rpcError(id ?? null, -32601, `Method not found: ${method}`);
        }
    } catch (err) {
        console.error('mcp dispatch failed', {
            method,
            errorType: err instanceof Error ? err.name : 'UnknownError',
        });
        return rpcError(id ?? null, -32603, 'Internal error');
    }
}

/** Build the `initialize` response — declares server identity + capabilities. */
function handleInitialize(_params) {
    return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false, subscribe: false },
        },
        serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
        },
    };
}

/**
 * Serve a widget bundle when the host fetches its URI. Lenient
 * prefix match resolves stale URIs (from previous deploys) to the
 * current bundle — old chats replay correctly.
 */
function handleResourcesRead(params) {
    const uri = typeof params?.uri === 'string' ? params.uri : '';
    const widget = lookupWidget(uri);
    if (!widget) {
        throw new Error(`Unknown resource URI: ${uri}`);
    }
    // Apps SDK reference: `_meta.ui.domain` is the dedicated origin
    // ChatGPT uses to sandbox the widget iframe (and to scope state
    // and storage). Required for app submission and must be unique
    // per app. We derive it from RESOURCE_URL (the public URL the
    // protected resource is served from). Fall back to the Apps SDK
    // shared sandbox if the env var isn't set.
    const widgetDomain = process.env.RESOURCE_URL?.replace(/\/+$/, '')
        ?? 'https://web-sandbox.oaiusercontent.com';
    return {
        contents: [
            {
                // Always echo the CURRENT versioned URI back, even
                // when the request asked for an older one — that
                // way the host updates its cache key.
                uri: widget.uri,
                mimeType: 'text/html+skybridge',
                text: widget.bundle,
                _meta: {
                    ui: {
                        prefersBorder: true,
                        csp: RESOURCE_CSP,
                        domain: widgetDomain,
                    },
                    'openai/widgetPrefersBorder': true,
                    'openai/widgetDomain': widgetDomain,
                    'openai/widgetDescription': descriptionFor(widget.name),
                },
            },
        ],
    };
}

/** Per-widget host-visible description. */
function descriptionFor(widgetName) {
    if (widgetName === 'balance') {
        return 'Securely renders your credit balance inside a sandboxed iframe. ' +
            'The amount is fetched via `window.openai.callTool` and never leaves ' +
            'the iframe.';
    }
    if (widgetName === 'branches') {
        return 'Lists Savvy branches with today\'s open/closed status. Public information; ' +
            'no per-customer data involved.';
    }
    return 'Sandboxed widget for the chatgpt-app-mcp demo.';
}

/** Dispatch `tools/call` to the appropriate tool implementation. */
async function handleToolsCall(params, context) {
    const name = typeof params?.name === 'string' ? params.name : '';
    // Enrich context with the request's JSON-RPC `_meta` so tools can
    // read `openai/userLocation`, `openai/locale`, etc. without each
    // handler reaching into params.
    const enriched = { ...context, requestMeta: params?._meta };
    if (name === STATUS_TOOL_NAME) {
        return getCreditBalanceStatus(enriched);
    }
    if (name === ACTUAL_TOOL_NAME) {
        return getCreditBalanceActual(params?.arguments ?? {}, enriched);
    }
    if (name === LIST_BRANCHES_TOOL_NAME) {
        return listBranches(params?.arguments ?? {}, enriched);
    }
    if (name === FIND_NEAREST_TOOL_NAME) {
        return findNearestBranches(params?.arguments ?? {}, enriched);
    }
    return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    };
}
