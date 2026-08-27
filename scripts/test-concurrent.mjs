#!/usr/bin/env node
/**
 * Cross-process scaffold for the concurrent-client-safety spec.
 *
 * Drives Property 3 (signal-driven lock release on SIGINT / SIGTERM /
 * SIGHUP / uncaught exit) and the integration leg of Property 4
 * (SIGKILL stale-lock reclamation). Spawns short-lived Node children
 * that import `LockCoordinator` from the built `@mcp-savvy/storage`
 * dist, acquire the lock for a shared `mkdtemp` data dir, then
 * receive the test scenario's terminating event. For each scenario
 * the parent verifies the child's exit metadata and then re-acquires
 * the lock as a sibling under the timing bound the property requires.
 *
 * This scaffold deliberately skips the full PKCE + IdP path the spec
 * mentions and exercises lock release in isolation — what Properties
 * 3 and 4 actually constrain. Run via `make test-concurrent` so the
 * workspace is built before the children try to import the dist.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { LockCoordinator } from '../packages/storage/dist/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const STORAGE_DIST = path.resolve(REPO_ROOT, 'packages/storage/dist/index.js');
const STORAGE_DIST_URL = pathToFileURL(STORAGE_DIST).href;

const HEARTBEAT_MS = 1000;
const STALENESS_MS = 5000;
const FAST_RECLAIM_BUDGET_MS = 1500;
const SIGKILL_RECLAIM_BUDGET_MS = STALENESS_MS + HEARTBEAT_MS + 200 + 2000;
const ACQUIRE_HANDSHAKE_TIMEOUT_MS = 5000;
const PER_CHILD_TIMEOUT_MS = 15_000;

const HOLDER_SCRIPT = `
import { LockCoordinator } from ${JSON.stringify(STORAGE_DIST_URL)};

const dataDir = process.env.HOLDER_DATA_DIR;
const namespace = process.env.HOLDER_NAMESPACE;
const holdMs = Number.parseInt(process.env.HOLDER_HOLD_MS ?? '60000', 10);
const heartbeatMs = Number.parseInt(process.env.HOLDER_HEARTBEAT_MS ?? '1000', 10);
const stalenessMs = Number.parseInt(process.env.HOLDER_STALENESS_MS ?? '5000', 10);
const crashAfterMs = Number.parseInt(process.env.HOLDER_CRASH_AFTER_MS ?? '0', 10);

// proper-lockfile's signal-exit hook registers its own SIGINT/SIGTERM/SIGHUP
// listeners that re-signal the process (so we'd exit with signal=SIGINT,
// code=null instead of code=130). Prepend our handlers so they run first
// and process.exit wins; Node's 'exit' event still fires, so signal-exit's
// onExit callback removes the lock file synchronously.
const exitForSignal = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
for (const [sig, code] of Object.entries(exitForSignal)) {
    process.prependListener(sig, () => process.exit(code));
}

const lock = new LockCoordinator({
    dataDir,
    heartbeatIntervalMs: heartbeatMs,
    stalenessThresholdMs: stalenessMs,
});
const handle = await lock.acquire({ namespace, timeoutMs: 60_000 });
process.stdout.write('ACQUIRED\\n');

if (crashAfterMs > 0) {
    setTimeout(() => { throw new Error('holder synthetic crash'); }, crashAfterMs);
} else {
    setTimeout(async () => {
        try { await lock.release(handle); } finally { process.exit(0); }
    }, holdMs);
}
`;

/** Module-load: namespace generator so every scenario gets a fresh lock file. */
let nsCounter = 0;
function nextNamespace(prefix) {
    nsCounter += 1;
    return `${prefix}-${nsCounter}`;
}

/** Spawn the holder child, returning handles for ACQUIRED-handshake + exit. */
function spawnHolder({ scriptPath, dataDir, namespace, extraEnv = {} }) {
    const child = spawn(process.execPath, [scriptPath], {
        env: {
            ...process.env,
            HOLDER_DATA_DIR: dataDir,
            HOLDER_NAMESPACE: namespace,
            HOLDER_HEARTBEAT_MS: String(HEARTBEAT_MS),
            HOLDER_STALENESS_MS: String(STALENESS_MS),
            ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
        stderrBuf += chunk;
    });

    const acquired = new Promise((resolve, reject) => {
        const onData = (chunk) => {
            stdoutBuf += chunk;
            if (stdoutBuf.includes('ACQUIRED\n')) {
                child.stdout.off('data', onData);
                resolve();
            }
        };
        child.stdout.on('data', onData);
        const guard = setTimeout(() => {
            child.stdout.off('data', onData);
            reject(new Error(
                `holder did not acquire within ${ACQUIRE_HANDSHAKE_TIMEOUT_MS}ms; ` +
                `stderr=${stderrBuf || '<empty>'}`,
            ));
        }, ACQUIRE_HANDSHAKE_TIMEOUT_MS);
        guard.unref();
        child.once('exit', () => clearTimeout(guard));
    });

    const exited = new Promise((resolve) => {
        child.once('exit', (code, signal) => {
            resolve({ code, signal, stderr: stderrBuf });
        });
    });

    const hardKill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
        }
    }, PER_CHILD_TIMEOUT_MS);
    hardKill.unref();
    void exited.then(() => clearTimeout(hardKill));

    return { child, acquired, exited };
}

/** Property 3 scenarios: signal → expected exit code → fast sibling acquire. */
const SIGNAL_SCENARIOS = [
    { name: 'SIGINT', signal: 'SIGINT', expectedCode: 130 },
    { name: 'SIGTERM', signal: 'SIGTERM', expectedCode: 143 },
    { name: 'SIGHUP', signal: 'SIGHUP', expectedCode: 129 },
];

/** Run one signal scenario and assert sibling acquires inside the fast budget. */
async function runSignalScenario(scenario, ctx) {
    const namespace = nextNamespace(`p3-${scenario.name.toLowerCase()}`);
    const holder = spawnHolder({
        scriptPath: ctx.holderPath,
        dataDir: ctx.dataDir,
        namespace,
    });
    await holder.acquired;
    holder.child.kill(scenario.signal);
    const { code, signal } = await holder.exited;
    if (code !== scenario.expectedCode) {
        throw new Error(
            `[${scenario.name}] expected exit code ${scenario.expectedCode}; ` +
            `got code=${code} signal=${signal}`,
        );
    }
    const siblingLock = new LockCoordinator({
        dataDir: ctx.dataDir,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessThresholdMs: STALENESS_MS,
    });
    const startedAt = Date.now();
    const handle = await siblingLock.acquire({ namespace, timeoutMs: 60_000 });
    const elapsedMs = Date.now() - startedAt;
    await siblingLock.release(handle);
    if (elapsedMs > FAST_RECLAIM_BUDGET_MS) {
        throw new Error(
            `[${scenario.name}] sibling acquired in ${elapsedMs}ms ` +
            `(> fast budget ${FAST_RECLAIM_BUDGET_MS}ms — staleness wait happened)`,
        );
    }
    process.stdout.write(
        `  ✓ ${scenario.name}: child exit=${scenario.expectedCode}, sibling acquired in ${elapsedMs}ms\n`,
    );
}

/** Property 3 uncaught-exit leg: throw inside the holder after acquire. */
async function runUncaughtScenario(ctx) {
    const namespace = nextNamespace('p3-uncaught');
    const holder = spawnHolder({
        scriptPath: ctx.holderPath,
        dataDir: ctx.dataDir,
        namespace,
        extraEnv: { HOLDER_CRASH_AFTER_MS: '150' },
    });
    await holder.acquired;
    const { code, signal } = await holder.exited;
    if (code !== 1) {
        throw new Error(
            `[uncaught] expected exit code 1; got code=${code} signal=${signal}`,
        );
    }
    const siblingLock = new LockCoordinator({
        dataDir: ctx.dataDir,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessThresholdMs: STALENESS_MS,
    });
    const startedAt = Date.now();
    const handle = await siblingLock.acquire({ namespace, timeoutMs: 60_000 });
    const elapsedMs = Date.now() - startedAt;
    await siblingLock.release(handle);
    if (elapsedMs > FAST_RECLAIM_BUDGET_MS) {
        throw new Error(
            `[uncaught] sibling acquired in ${elapsedMs}ms ` +
            `(> fast budget ${FAST_RECLAIM_BUDGET_MS}ms)`,
        );
    }
    process.stdout.write(
        `  ✓ uncaught: child exit=1, sibling acquired in ${elapsedMs}ms\n`,
    );
}

/** Property 4 integration leg: SIGKILL → sibling waits ≤ staleness + heartbeat + slack. */
async function runSigkillScenario(ctx) {
    const namespace = nextNamespace('p4-sigkill');
    const holder = spawnHolder({
        scriptPath: ctx.holderPath,
        dataDir: ctx.dataDir,
        namespace,
    });
    await holder.acquired;
    holder.child.kill('SIGKILL');
    const { code, signal } = await holder.exited;
    if (signal !== 'SIGKILL') {
        throw new Error(
            `[SIGKILL] expected signal=SIGKILL; got code=${code} signal=${signal}`,
        );
    }
    const siblingLock = new LockCoordinator({
        dataDir: ctx.dataDir,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessThresholdMs: STALENESS_MS,
    });
    const startedAt = Date.now();
    const handle = await siblingLock.acquire({ namespace, timeoutMs: 60_000 });
    const elapsedMs = Date.now() - startedAt;
    await siblingLock.release(handle);
    if (elapsedMs > SIGKILL_RECLAIM_BUDGET_MS) {
        throw new Error(
            `[SIGKILL] sibling acquired in ${elapsedMs}ms ` +
            `(> staleness+heartbeat+slack budget ${SIGKILL_RECLAIM_BUDGET_MS}ms)`,
        );
    }
    process.stdout.write(
        `  ✓ SIGKILL: child killed, sibling acquired in ${elapsedMs}ms ` +
        `(budget ${SIGKILL_RECLAIM_BUDGET_MS}ms)\n`,
    );
}

/** Drive every scenario sequentially against a freshly-mkdtemp'd data dir. */
async function main() {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'mcp-savvy-concurrent-'));
    const dataDir = path.join(tmpRoot, 'data');
    const holderPath = path.join(tmpRoot, 'holder.mjs');
    await writeFile(holderPath, HOLDER_SCRIPT, 'utf8');
    const ctx = { dataDir, holderPath };
    process.stdout.write(`scaffold root: ${tmpRoot}\n`);
    process.stdout.write('Property 3 (signal release):\n');
    try {
        for (const scenario of SIGNAL_SCENARIOS) {
            await runSignalScenario(scenario, ctx);
            // Small idle gap so back-to-back spawns don't race the lock fd.
            await sleep(50);
        }
        await runUncaughtScenario(ctx);
        process.stdout.write('Property 4 (SIGKILL stale reclamation):\n');
        await runSigkillScenario(ctx);
        process.stdout.write('\nOK\n');
    } finally {
        await rm(tmpRoot, { recursive: true, force: true });
    }
}

main().catch((err) => {
    process.stderr.write(`FAIL: ${err.message}\n`);
    process.exit(1);
});
