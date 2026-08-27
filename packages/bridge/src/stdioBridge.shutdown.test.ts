/**
 * Shutdown-framing tests for `StdioBridge`.
 *
 * Covers both halves of concurrent-client-safety's shutdown-framing
 * work in one file:
 *
 *   • Task 6.3 — example-based invariants for `flushPendingAsErrors`
 *     (Req 5.4, 5.5, 5.8). Each test exercises one branch of the
 *     flush loop with a hand-picked scenario.
 *
 *   • Task 8.4 — Properties 9 and 10. Property 9 sweeps M ∈ [0, 20]
 *     mixed-JSON-type request ids and the three error categories
 *     and asserts byte-and-type-equal id preservation, `error.code`
 *     enumeration, and `pending.size === 0` after flush. Property
 *     10 sweeps all three shutdown scenarios (remote failure, host
 *     close, external shutdown) and asserts JSON-RPC 2.0 discipline
 *     on host stdout — including the Req 5.5 "no synthetic frames
 *     when the host closed first" invariant.
 *
 * The bridge's `pending` map is a private field; tests read it via
 * a typed cast rather than adding a production-side getter, to keep
 * the public surface clean (Req 5.4 is verified by side channel).
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { AuthError, McpSavvyError, type Logger } from '@mcp-savvy/core';
import { StdioBridge } from './stdioBridge.js';
import { BRIDGE_ERROR_CODES, type BridgeErrorCategory } from './bridgeErrors.js';
import { fakeTransport, type FakeTransport, tick } from './testFixtures.js';

/** Synthetic JSON-RPC error frame shape produced by `flushPendingAsErrors`. */
interface EmittedErrorFrame {
    jsonrpc: '2.0';
    id: string | number;
    error: { code: number; message: string; data?: unknown };
}

/** Build a JSON-RPC request frame with the given id (forces it through `isJSONRPCRequest`). */
function makeRequest(id: string | number): JSONRPCMessage {
    return { jsonrpc: '2.0', id, method: 'tools/call', params: {} };
}

/** Peek at the bridge's private pending map. Tests only. */
function pendingOf(bridge: StdioBridge): Map<string | number, unknown> {
    return (bridge as unknown as { pending: Map<string | number, unknown> }).pending;
}

/** Minimal test logger; only records warn lines we care about. */
function recordingLogger(warns: string[]): Logger {
    const noop = (): void => undefined;
    const self: Logger = {
        debug: noop,
        info: noop,
        warn: (m) => warns.push(m),
        error: noop,
        child: () => self,
    };
    return self;
}

/** Spawn a bridge wired to a host+remote fake pair, with an optional warn-capture logger. */
function buildBridge(opts: {
    host: FakeTransport;
    remote: FakeTransport;
    warns?: string[];
}): StdioBridge {
    return new StdioBridge({
        remoteUrl: 'https://example.com/mcp',
        getAccessToken: async () => 'tok',
        stdioTransport: () => opts.host,
        remoteTransport: () => opts.remote,
        logger: opts.warns ? recordingLogger(opts.warns) : undefined,
    });
}

describe('flushPendingAsErrors (example-based, task 6.3)', () => {
    it('emits zero synthetic frames when the host closes first (Req 5.5)', async () => {
        const host = fakeTransport();
        const remote = fakeTransport();
        const bridge = buildBridge({ host, remote });
        const running = bridge.run();
        await tick();
        host.fireMessage(makeRequest(1));
        await tick();
        // Host hangs up before any failure path runs; bridge must not
        // synthesize error frames into a closed pipe.
        host.fireClose();
        await running;
        expect(host.sent).toEqual([]);
    });

    it('logs warn per failed send and continues the loop (Req 5.8)', async () => {
        const warns: string[] = [];
        const host = fakeTransport();
        // First two error-frame sends throw; the third lands. Loop must
        // log each failure and keep iterating across the pending map.
        let sendCalls = 0;
        host.send = async (msg: JSONRPCMessage) => {
            sendCalls += 1;
            if (sendCalls <= 2) throw new Error(`send-fail-${sendCalls}`);
            host.sent.push(msg);
        };
        const remote = fakeTransport();
        const bridge = buildBridge({ host, remote, warns });
        const running = bridge.run();
        await tick();
        for (const id of [1, 2, 3]) host.fireMessage(makeRequest(id));
        await tick();
        remote.fireError(new Error('remote-boom'));
        await running;
        // Two warn lines for the two failures; loop did not bail early.
        expect(warns.filter((w) => w.includes('error-frame send failed'))).toHaveLength(2);
        expect(host.sent).toHaveLength(1);
    });

    it('clears the pending map after flush (Req 5.4)', async () => {
        const host = fakeTransport();
        const remote = fakeTransport();
        const bridge = buildBridge({ host, remote });
        const running = bridge.run();
        await tick();
        for (const id of [1, 2, 3]) host.fireMessage(makeRequest(id));
        await tick();
        expect(pendingOf(bridge).size).toBe(3);
        remote.fireError(new Error('remote-boom'));
        await running;
        expect(pendingOf(bridge).size).toBe(0);
        expect(host.sent).toHaveLength(3);
    });
});

/** Build an error of the named category so `handleRemoteError`+`categorizeBridgeError` route to it. */
function errorFor(category: BridgeErrorCategory): Error {
    switch (category) {
        case 'BRIDGE_AUTH_FAILURE':
            return new AuthError('UNAUTHORIZED', 'auth boom');
        case 'BRIDGE_INTERCEPTOR_FAILURE':
            return new McpSavvyError('BRIDGE_INTERCEPTOR_FAILURE', 'interceptor boom');
        case 'BRIDGE_TRANSPORT_FAILURE':
            return new Error('transport boom');
    }
}

/** Stable string key derived from a JSON-RPC id that distinguishes string vs number type. */
function idKey(id: string | number): string {
    return `${typeof id}:${String(id)}`;
}

/**
 * Arbitrary for a unique JSON-RPC id set of length 0–20, mixing
 * string and number ids. Uniqueness is type-aware: `1` (number)
 * and `'1'` (string) are kept as distinct entries because the
 * bridge's `pending` Map treats them as distinct keys.
 */
const idsArb = fc.uniqueArray(
    fc.oneof(
        fc.integer({ min: 1, max: 100_000 }),
        fc.string({ minLength: 1, maxLength: 16 }),
    ),
    { selector: idKey, minLength: 0, maxLength: 20 },
);

const categoryArb = fc.constantFrom<BridgeErrorCategory>(
    'BRIDGE_TRANSPORT_FAILURE',
    'BRIDGE_AUTH_FAILURE',
    'BRIDGE_INTERCEPTOR_FAILURE',
);

describe('flushPendingAsErrors (property-based, task 8.4)', () => {
    it(
        'Property 9: one type-preserved JSON-RPC error frame per in-flight id',
        async () => {
            // Feature: concurrent-client-safety, Property 9: JSON-RPC error frame per in-flight id, type-preserved
            // Validates: Requirements 5.1, 5.2, 5.3, 5.4
            await fc.assert(
                fc.asyncProperty(idsArb, categoryArb, async (ids, category) => {
                    const host = fakeTransport();
                    const remote = fakeTransport();
                    const bridge = buildBridge({ host, remote });
                    const running = bridge.run();
                    await tick();
                    for (const id of ids) host.fireMessage(makeRequest(id));
                    await tick();
                    expect(pendingOf(bridge).size).toBe(ids.length);
                    remote.fireError(errorFor(category));
                    await running;

                    // Exactly M frames — no extras, no drops.
                    expect(host.sent).toHaveLength(ids.length);
                    const expectedCode = BRIDGE_ERROR_CODES[category];
                    const allowedKeys = new Set(ids.map(idKey));
                    for (const sent of host.sent) {
                        const frame = sent as EmittedErrorFrame;
                        expect(frame.jsonrpc).toBe('2.0');
                        // Type-equal AND byte-equal: round-trips through idKey.
                        const t = typeof frame.id;
                        expect(t === 'string' || t === 'number').toBe(true);
                        expect(allowedKeys.has(idKey(frame.id))).toBe(true);
                        // Category-correct JSON-RPC error code (one of the three enum values).
                        expect(frame.error.code).toBe(expectedCode);
                    }
                    expect(pendingOf(bridge).size).toBe(0);
                }),
                { numRuns: 30 },
            );
        },
        60_000,
    );

    it(
        'Property 10: every host-stdout frame is a valid JSON-RPC 2.0 error frame; zero on host-close',
        async () => {
            // Feature: concurrent-client-safety, Property 10: Host stdout JSON-RPC discipline during shutdown
            // Validates: Requirements 5.5, 5.6, 5.7, 9.5
            const scenarioArb = fc.constantFrom(
                'remote-failure',
                'host-close',
                'external-shutdown',
            );
            const validCodes = new Set<number>([
                BRIDGE_ERROR_CODES.BRIDGE_TRANSPORT_FAILURE,
                BRIDGE_ERROR_CODES.BRIDGE_AUTH_FAILURE,
                BRIDGE_ERROR_CODES.BRIDGE_INTERCEPTOR_FAILURE,
            ]);
            await fc.assert(
                fc.asyncProperty(
                    fc.integer({ min: 0, max: 5 }),
                    scenarioArb,
                    async (m, scenario) => {
                        const host = fakeTransport();
                        const remote = fakeTransport();
                        const bridge = buildBridge({ host, remote });
                        const running = bridge.run();
                        await tick();
                        for (let i = 1; i <= m; i += 1) host.fireMessage(makeRequest(i));
                        await tick();

                        if (scenario === 'remote-failure') {
                            remote.fireError(new Error('boom'));
                        } else if (scenario === 'host-close') {
                            host.fireClose();
                        } else {
                            await bridge.shutdown();
                        }
                        await running;

                        // Req 5.5: host closed first or shut down externally → no synthetic frames.
                        if (scenario === 'host-close' || scenario === 'external-shutdown') {
                            expect(host.sent).toEqual([]);
                        } else {
                            expect(host.sent).toHaveLength(m);
                        }

                        // Req 5.6/5.7: every byte written to host stdout is a valid
                        // JSON-RPC 2.0 error frame — no log lines, no partial JSON.
                        for (const sent of host.sent) {
                            const frame = sent as EmittedErrorFrame;
                            expect(frame.jsonrpc).toBe('2.0');
                            const t = typeof frame.id;
                            expect(t === 'string' || t === 'number').toBe(true);
                            expect(typeof frame.error.code).toBe('number');
                            expect(validCodes.has(frame.error.code)).toBe(true);
                            expect(typeof frame.error.message).toBe('string');
                        }
                    },
                ),
                { numRuns: 30 },
            );
        },
        60_000,
    );
});
