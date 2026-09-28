/** Acceptance coverage for bounded 401 recovery and process-local transport ownership. */

import type { Logger } from '@mcp-savvy/core';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { StdioBridge } from '../stdioBridge.js';
import { fakeTransport, SAMPLE_REQUEST, tick, type FakeTransport } from '../testFixtures.js';

interface LogRecord {
    level: 'warn' | 'error';
    message: string;
    fields?: Record<string, unknown>;
}

function recordingLogger(records: LogRecord[]): Logger {
    const noop = (): void => undefined;
    const logger: Logger = {
        debug: noop,
        info: noop,
        warn: (message, fields) => records.push({ level: 'warn', message, fields }),
        error: (message, fields) => records.push({ level: 'error', message, fields }),
        child: () => logger,
    };
    return logger;
}

function unauthorized(): Error {
    return Object.assign(new Error('unauthorized'), { code: 401 });
}

function createBridgeHarness(maxReauthAttempts?: number): {
    bridge: StdioBridge;
    host: FakeTransport;
    remotes: FakeTransport[];
    tokenRequests: boolean[];
    diagnostics: Array<[number, number]>;
    logs: LogRecord[];
} {
    const host = fakeTransport();
    const remotes: FakeTransport[] = [];
    const tokenRequests: boolean[] = [];
    const diagnostics: Array<[number, number]> = [];
    const logs: LogRecord[] = [];
    const bridge = new StdioBridge({
        remoteUrl: 'https://example.com/mcp',
        getAccessToken: async ({ forceRefresh }) => {
            tokenRequests.push(forceRefresh);
            return `token-${tokenRequests.length}`;
        },
        stdioTransport: () => host,
        remoteTransport: () => {
            const remote = fakeTransport();
            remotes.push(remote);
            return remote;
        },
        diagnostics: {
            reauthentication: (consumed, budget) => diagnostics.push([consumed, budget]),
        },
        logger: recordingLogger(logs),
        ...(maxReauthAttempts === undefined ? {} : { maxReauthAttempts }),
    });
    return { bridge, host, remotes, tokenRequests, diagnostics, logs };
}

describe('bounded 401 recovery acceptance', () => {
    it('uses the default one-attempt budget and performs no token call after exhaustion', async () => {
        const harness = createBridgeHarness();
        const running = harness.bridge.run();
        await tick();

        harness.remotes[0]!.fireError(unauthorized());
        await tick();
        expect(harness.tokenRequests).toEqual([false, true]);
        expect(harness.remotes).toHaveLength(2);
        expect(harness.host.closed).toBe(false);
        expect(harness.diagnostics).toEqual([[1, 1]]);
        expect(harness.logs).toContainEqual({
            level: 'warn',
            message: 'remote returned 401; reconnecting',
            fields: { consumedAttempts: 1, reauthenticationBudget: 1 },
        });

        harness.remotes[1]!.fireError(unauthorized());
        await running;
        expect(harness.tokenRequests).toEqual([false, true]);
        expect(harness.remotes).toHaveLength(2);
        expect(harness.diagnostics).toEqual([[1, 1], [1, 1]]);
        expect(harness.logs).toContainEqual({
            level: 'error',
            message: 'remote returned 401; reauth budget exhausted',
            fields: { consumedAttempts: 1, reauthenticationBudget: 1 },
        });
    });

    it('honours a configured budget and reports every consumed and exhausted attempt count', async () => {
        const harness = createBridgeHarness(2);
        const running = harness.bridge.run();
        await tick();

        harness.remotes[0]!.fireError(unauthorized());
        await tick();
        expect(harness.tokenRequests).toEqual([false, true]);
        expect(harness.remotes).toHaveLength(2);
        expect(harness.host.closed).toBe(false);
        expect(harness.diagnostics).toEqual([[1, 2]]);

        harness.remotes[1]!.fireError(unauthorized());
        await tick();
        expect(harness.tokenRequests).toEqual([false, true, true]);
        expect(harness.remotes).toHaveLength(3);
        expect(harness.host.closed).toBe(false);
        expect(harness.diagnostics).toEqual([[1, 2], [2, 2]]);

        harness.remotes[2]!.fireError(unauthorized());
        await running;
        expect(harness.tokenRequests).toEqual([false, true, true]);
        expect(harness.remotes).toHaveLength(3);
        expect(harness.diagnostics).toEqual([[1, 2], [2, 2], [2, 2]]);
        const exhausted = harness.logs.find(
            ({ message }) => message === 'remote returned 401; reauth budget exhausted',
        );
        expect(exhausted?.fields).toEqual({
            consumedAttempts: 2,
            reauthenticationBudget: 2,
        });
    });

    it('replaces only the current bridge transport and leaves a sibling bridge independent', async () => {
        const first = createBridgeHarness();
        const sibling = createBridgeHarness();
        const firstRunning = first.bridge.run();
        const siblingRunning = sibling.bridge.run();
        await tick();

        first.remotes[0]!.fireError(unauthorized());
        await tick();
        expect(first.remotes).toHaveLength(2);
        expect(first.remotes[0]!.closed).toBe(true);
        expect(first.remotes[1]!.started).toBe(true);
        expect(sibling.remotes).toHaveLength(1);
        expect(sibling.remotes[0]!.closed).toBe(false);
        expect(sibling.tokenRequests).toEqual([false]);

        sibling.host.fireMessage(SAMPLE_REQUEST as JSONRPCMessage);
        await tick();
        expect(sibling.remotes[0]!.sent).toEqual([SAMPLE_REQUEST]);
        first.host.fireClose();
        sibling.host.fireClose();
        await Promise.all([firstRunning, siblingRunning]);
    });
});
