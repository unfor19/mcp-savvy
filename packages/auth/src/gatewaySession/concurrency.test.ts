/** Callback-port contention tests for AgentCore session completion. */

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { listenOnLoopback } from './loopback.js';

const servers: Server[] = [];

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) =>
        server.close((err) => err ? reject(err) : resolve()),
    );
}

afterEach(async () => {
    await Promise.all(servers.splice(0).map(closeServer));
});

describe('3LO callback-port acquisition', () => {
    it('waits for another flow to release the registered port', async () => {
        const owner = createServer();
        servers.push(owner);
        await listenOnLoopback(owner, 0);
        const address = owner.address();
        if (!address || typeof address === 'string') throw new Error('missing test port');

        const waiter = createServer();
        servers.push(waiter);
        let acquired = false;
        const waiting = listenOnLoopback(waiter, address.port, 1_000).then(() => {
            acquired = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(acquired).toBe(false);

        await closeServer(owner);
        await waiting;
        expect(waiter.listening).toBe(true);
    });
});
