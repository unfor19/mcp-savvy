/** Parent-side protocol for deterministic cross-process authentication fixtures. */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD_PATH = path.join(HERE, 'child.mjs');
const MESSAGE_TIMEOUT_MS = 10_000;

/** Capabilities guaranteed by the cross-process fixture child protocol. */
export const AUTH_FIXTURE_CAPABILITIES = [
    'empty-cache-pkce',
    'stale-cache-refresh',
    'sequential-reuse',
    'lock-timeout',
    'diagnostic-capture',
    'process-local-transport',
];

function timeoutError(label, stderr) {
    return new Error(`${label} timed out; stderr=${stderr || '<empty>'}`);
}

/** Spawn one isolated fixture process using real storage, lock, manager, and bridge seams. */
export async function spawnAuthFixture(input) {
    const child = spawn(process.execPath, [CHILD_PATH], {
        env: {
            ...process.env,
            MCP_SAVVY_FIXTURE_CONFIG: JSON.stringify({
                processLabel: input.processLabel,
                dataDir: input.dataDir,
                namespace: input.namespace,
                nowMs: input.nowMs,
                lockTimeoutMs: input.lockTimeoutMs,
                authorizationTokens: input.authorizationTokens,
                refreshTokens: input.refreshTokens,
                refreshOutcome: input.refreshOutcome ?? 'success',
                authorizationDelayMs: input.authorizationDelayMs ?? 0,
                refreshDelayMs: input.refreshDelayMs ?? 0,
            }),
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });

    let stderr = '';
    let requestSequence = 0;
    const pending = new Map();
    const observations = [];
    const observationWaiters = new Set();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
        stderr += chunk;
    });

    const exited = new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
    });
    const ready = new Promise((resolve, reject) => {
        const guard = setTimeout(
            () => reject(timeoutError('fixture ready handshake', stderr)),
            MESSAGE_TIMEOUT_MS,
        );
        child.on('message', (message) => {
            if (message?.kind !== 'ready') return;
            clearTimeout(guard);
            resolve(message);
        });
        child.once('exit', (code, signal) => {
            clearTimeout(guard);
            reject(new Error(
                `fixture exited before ready: code=${code} signal=${signal}; ` +
                `stderr=${stderr || '<empty>'}`,
            ));
        });
    });

    child.on('message', (message) => {
        if (message?.kind === 'observation') {
            observations.push(message);
            for (const waiter of observationWaiters) waiter(message);
            return;
        }
        if (message?.kind !== 'response') return;
        const handler = pending.get(message.requestId);
        if (!handler) return;
        pending.delete(message.requestId);
        clearTimeout(handler.guard);
        if (message.ok) handler.resolve(message.value);
        else {
            const error = new Error(message.error.message);
            error.name = message.error.name;
            if (message.error.code) error.code = message.error.code;
            handler.reject(error);
        }
    });

    child.once('exit', (code, signal) => {
        for (const handler of pending.values()) {
            clearTimeout(handler.guard);
            handler.reject(new Error(
                `fixture exited during request: code=${code} signal=${signal}; ` +
                `stderr=${stderr || '<empty>'}`,
            ));
        }
        pending.clear();
    });

    const readyMessage = await ready;

    function request(command, payload = {}) {
        requestSequence += 1;
        const requestId = `${readyMessage.processId}:${requestSequence}`;
        return new Promise((resolve, reject) => {
            const guard = setTimeout(() => {
                pending.delete(requestId);
                reject(timeoutError(`fixture command ${command}`, stderr));
            }, MESSAGE_TIMEOUT_MS);
            pending.set(requestId, { resolve, reject, guard });
            child.send({ kind: 'request', requestId, command, payload });
        });
    }

    function waitForObservation(predicate, timeoutMs = MESSAGE_TIMEOUT_MS) {
        const existing = observations.find(predicate);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
            const guard = setTimeout(() => {
                observationWaiters.delete(onObservation);
                reject(timeoutError('fixture observation', stderr));
            }, timeoutMs);
            const onObservation = (observation) => {
                if (!predicate(observation)) return;
                clearTimeout(guard);
                observationWaiters.delete(onObservation);
                resolve(observation);
            };
            observationWaiters.add(onObservation);
        });
    }

    async function close() {
        if (child.exitCode === null && child.signalCode === null) {
            await request('shutdown');
        }
        const result = await exited;
        if (result.code !== 0) {
            throw new Error(
                `fixture shutdown failed: code=${result.code} signal=${result.signal}; ` +
                `stderr=${result.stderr || '<empty>'}`,
            );
        }
    }

    return {
        processId: readyMessage.processId,
        capabilities: readyMessage.capabilities,
        observations,
        request,
        waitForObservation,
        close,
        exited,
    };
}

/** Verify the built child can negotiate every task 5.1 protocol capability. */
export async function verifyAuthFixtureProtocol(input) {
    const fixture = await spawnAuthFixture({
        ...input,
        processLabel: 'protocol-check',
        nowMs: 1_700_000_000_000,
        lockTimeoutMs: 1_000,
        authorizationTokens: {
            access_token: 'fixture-authorization-token',
            expires_at: 1_700_000_300_000,
        },
        refreshTokens: {
            access_token: 'fixture-refresh-token',
            expires_at: 1_700_000_300_000,
        },
    });
    try {
        const description = await fixture.request('describe');
        if (JSON.stringify(description.capabilities) !== JSON.stringify(AUTH_FIXTURE_CAPABILITIES)) {
            throw new Error('fixture child reported an incompatible capability set');
        }
        return description;
    } finally {
        await fixture.close();
    }
}
