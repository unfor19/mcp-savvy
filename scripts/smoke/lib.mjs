/**
 * Shared helpers for live MCP smoke tests.
 *
 * Each example's smoke script (minimal.mjs, gateway-lambda.mjs, …)
 * spawns the built mcp-savvy bridge as a child process and exchanges
 * JSON-RPC frames over stdio. The reading/dispatching loop is the
 * same regardless of which example runs.
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Absolute path to the built mcp-savvy CLI entrypoint. */
export const CLI_PATH = resolve(HERE, '..', '..', 'packages', 'cli', 'dist', 'cli.cjs');

/**
 * Read newline-delimited JSON-RPC frames off a stream and dispatch
 * them to a queue or to a single waiter at a time.
 */
export function jsonRpcReader() {
    let buf = '';
    const queue = [];
    const waiters = [];
    const onLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg;
        try {
            msg = JSON.parse(trimmed);
        } catch {
            return;
        }
        if (waiters.length > 0) waiters.shift()(msg);
        else queue.push(msg);
    };
    const feedChunk = (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
            onLine(buf.slice(0, nl));
            buf = buf.slice(nl + 1);
        }
    };
    const nextMessage = () =>
        queue.length > 0
            ? Promise.resolve(queue.shift())
            : new Promise((res) => waiters.push(res));
    return { feedChunk, nextMessage };
}

/** Send one JSON-RPC frame to the bridge over stdin. */
export function sendFrame(child, msg) {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
}

/** Block until a frame with `id` arrives, or throw on timeout. */
export async function awaitId(reader, id, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        let timeout;
        const timeoutPromise = new Promise((resolveTimeout) => {
            timeout = setTimeout(
                () => resolveTimeout(null),
                Math.max(0, deadline - Date.now()),
            );
        });
        const msg = await Promise.race([reader.nextMessage(), timeoutPromise]);
        clearTimeout(timeout);
        if (!msg) break;
        if (msg.id === id) return msg;
    }
    throw new Error(`timeout waiting for response id=${id}`);
}

/**
 * Spawn the mcp-savvy bridge with the current process env (which
 * must include `MCP_SAVVY_REMOTE_URL`, `MCP_SAVVY_OIDC_ISSUER`,
 * `MCP_SAVVY_CLIENT_ID`). Returns the child plus a JSON-RPC reader
 * already bound to its stdout.
 */
export function spawnBridge() {
    const required = ['MCP_SAVVY_REMOTE_URL', 'MCP_SAVVY_OIDC_ISSUER', 'MCP_SAVVY_CLIENT_ID'];
    for (const k of required) {
        if (!process.env[k]) {
            console.error(`missing env: ${k}`);
            process.exit(2);
        }
    }
    const child = spawn(process.execPath, [CLI_PATH], {
        env: process.env,
        stdio: ['pipe', 'pipe', 'inherit'],
    });
    const reader = jsonRpcReader();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', reader.feedChunk);
    child.on('exit', (code, signal) => {
        if (code !== 0 && code !== null) {
            console.error(`bridge exited code=${code} signal=${signal}`);
        }
    });
    return { child, reader };
}

/**
 * Drive the standard MCP `initialize` + `notifications/initialized`
 * handshake. Returns the parsed `initialize` response so callers can
 * inspect `serverInfo` etc.
 */
export async function initializeMcp(child, reader, clientInfo) {
    sendFrame(child, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo,
        },
    });
    const initResp = await awaitId(reader, 1);
    if (initResp.error) {
        throw new Error(`initialize failed: ${JSON.stringify(initResp.error)}`);
    }
    sendFrame(child, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
    });
    return initResp;
}

/** Best-effort cleanup at the end of a smoke run. */
export async function shutdownBridge(child) {
    child.kill('SIGTERM');
    await sleep(100);
}

/** Extract a JSON object from MCP `content[].text`, falling back to structured. */
export function extractToolResult(callResp) {
    if (callResp.result?.structuredContent) return callResp.result.structuredContent;
    const text = callResp.result?.content
        ?.map((c) => (c.type === 'text' ? c.text : ''))
        .join('');
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return { raw: text };
    }
}
