/**
 * Test-only helpers shared across `bridge` test files. Excluded
 * from the published build and from coverage.
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** Fake transport: stores sent messages, exposes hooks to fire callbacks. */
export interface FakeTransport extends Transport {
    sent: JSONRPCMessage[];
    started: boolean;
    closed: boolean;
    fireMessage(msg: JSONRPCMessage): void;
    fireError(err: Error): void;
    fireClose(): void;
}

/** Build a `FakeTransport` ready to be driven by a test. */
export function fakeTransport(): FakeTransport {
    const t: FakeTransport = {
        sent: [],
        started: false,
        closed: false,
        async start() {
            t.started = true;
        },
        async send(msg) {
            t.sent.push(msg);
        },
        async close() {
            t.closed = true;
            t.onclose?.();
        },
        fireMessage(msg) {
            t.onmessage?.(msg);
        },
        fireError(err) {
            t.onerror?.(err);
        },
        fireClose() {
            t.onclose?.();
        },
    };
    return t;
}

/** Sample JSON-RPC request used across tests. */
export const SAMPLE_REQUEST: JSONRPCMessage = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
};

/** Yield the event loop a few ticks so async forwards complete. */
export async function tick(ms = 10): Promise<void> {
    await new Promise<void>((r) => setTimeout(r, ms));
}
