/** Deterministic child process for cross-process authentication fixtures. */

import { setTimeout as sleep } from 'node:timers/promises';

import { AuthError } from '../../../packages/core/dist/index.js';
import { StdioBridge } from '../../../packages/bridge/dist/index.js';
import {
    EncryptedFileTokenStore,
    LockCoordinator,
} from '../../../packages/storage/dist/index.js';
import { TokenManager } from '../../../packages/cli/test-dist/token-manager.js';

const config = JSON.parse(process.env.MCP_SAVVY_FIXTURE_CONFIG ?? '{}');
const processId = `${config.processLabel ?? 'fixture'}:${process.pid}`;
let transportSequence = 0;

const capabilities = [
    'empty-cache-pkce',
    'stale-cache-refresh',
    'sequential-reuse',
    'lock-timeout',
    'diagnostic-capture',
    'process-local-transport',
];

function observe(event, details = {}) {
    process.send?.({ kind: 'observation', processId, event, details });
}

function safeError(error) {
    const value = error instanceof Error ? error : new Error(String(error));
    return {
        name: value.name,
        message: value.message,
        ...(typeof value.code === 'string' ? { code: value.code } : {}),
    };
}

const persistentStore = new EncryptedFileTokenStore({
    namespace: config.namespace,
    dataDir: config.dataDir,
});
const observedStore = {
    async get() {
        observe('store-read');
        const tokens = await persistentStore.get();
        observe('store-read-complete', { found: tokens !== null });
        return tokens;
    },
    async set(tokens) {
        observe('store-write');
        await persistentStore.set(tokens);
        observe('store-write-complete');
    },
    async clear() {
        observe('store-clear');
        await persistentStore.clear();
        observe('store-clear-complete');
    },
};

function configuredTokens(kind) {
    const tokens = config[`${kind}Tokens`];
    if (!tokens) throw new Error(`fixture ${kind} tokens are not configured`);
    return tokens;
}

const auth = {
    async prepareAuthorize() {
        observe('authorization-prepare');
        await sleep(config.authorizationDelayMs ?? 0);
        return {
            authorizeUrl: 'https://fixture.invalid/authorize',
            codeVerifier: 'fixture-verifier',
            state: 'fixture-state',
            redirectUri: 'http://localhost/fixture-callback',
        };
    },
    async exchangeCode() {
        observe('authorization-exchange');
        return configuredTokens('authorization');
    },
    async refresh() {
        observe('refresh-attempt');
        await sleep(config.refreshDelayMs ?? 0);
        if (config.refreshOutcome === 'rejected') {
            throw new AuthError('TOKEN_REFRESH_FAILED', 'fixture refresh rejected');
        }
        if (config.refreshOutcome === 'error') {
            throw new Error('fixture refresh error');
        }
        return configuredTokens('refresh');
    },
};

function callbackServer() {
    return {
        async listen() {
            observe('callback-listen');
        },
        async awaitCallback() {
            observe('callback-received');
            return { code: 'fixture-code', state: 'fixture-state' };
        },
        async stop() {
            observe('callback-stop');
        },
    };
}

const diagnostics = {
    initialization: (...args) => observe('diagnostic', { method: 'initialization', args }),
    backendRead: (...args) => observe('diagnostic', { method: 'backendRead', args }),
    credential: (...args) => observe('diagnostic', { method: 'credential', args }),
    refresh: (...args) => observe('diagnostic', { method: 'refresh', args }),
    interactiveSignIn: (...args) => observe('diagnostic', { method: 'interactiveSignIn', args }),
    lockTimeout: (...args) => observe('diagnostic', { method: 'lockTimeout', args }),
    reauthentication: (...args) => observe('diagnostic', { method: 'reauthentication', args }),
};

const lock = new LockCoordinator({ dataDir: config.dataDir });
const manager = new TokenManager({
    auth,
    store: observedStore,
    createCallbackServer: callbackServer,
    openBrowser: async () => observe('browser-launch'),
    diagnostics,
    now: () => config.nowMs,
    lock,
    namespace: config.namespace,
    lockTimeoutMs: config.lockTimeoutMs,
});

function fakeTransport(role, transportId, closeAfterMs) {
    const transport = {
        async start() {
            observe('transport-started', { role, transportId, owner: processId });
            if (role === 'host' && closeAfterMs !== undefined) {
                setTimeout(() => transport.onclose?.(), closeAfterMs);
            }
        },
        async send() { },
        async close() {
            observe('transport-closed', { role, transportId, owner: processId });
        },
    };
    return transport;
}

async function runTransport(payload) {
    transportSequence += 1;
    const localId = `${processId}:transport-${transportSequence}`;
    const host = fakeTransport('host', `${localId}:host`, payload.closeAfterMs ?? 0);
    const remoteIds = [];
    const bridge = new StdioBridge({
        remoteUrl: 'https://fixture.invalid/mcp',
        getAccessToken: (input) => manager.getAccessToken(input),
        diagnostics,
        stdioTransport: () => host,
        remoteTransport: () => {
            const transportId = `${localId}:remote-${remoteIds.length + 1}`;
            remoteIds.push(transportId);
            observe('transport-created', {
                role: 'remote',
                transportId,
                owner: processId,
            });
            return fakeTransport('remote', transportId);
        },
    });
    await bridge.run();
    return { owner: processId, remoteIds };
}

async function execute(command, payload) {
    switch (command) {
        case 'describe':
            return { capabilities, processId };
        case 'seed':
            await persistentStore.set(payload.tokens);
            return { seeded: true };
        case 'clear':
            await persistentStore.clear();
            return { cleared: true };
        case 'authenticate':
            return {
                accessToken: await manager.getAccessToken({
                    forceRefresh: payload.forceRefresh ?? false,
                }),
            };
        case 'hold-lock':
            return lock.withLock(
                { namespace: config.namespace, timeoutMs: config.lockTimeoutMs },
                async () => {
                    observe('lock-held');
                    await sleep(payload.holdMs);
                    return { heldMs: payload.holdMs };
                },
            );
        case 'transport':
            return runTransport(payload);
        case 'shutdown':
            return { shuttingDown: true };
        default:
            throw new Error(`unknown fixture command: ${command}`);
    }
}

process.on('message', async (message) => {
    if (message?.kind !== 'request') return;
    try {
        const value = await execute(message.command, message.payload ?? {});
        process.send?.({ kind: 'response', requestId: message.requestId, ok: true, value });
        if (message.command === 'shutdown') setImmediate(() => process.exit(0));
    } catch (error) {
        process.send?.({
            kind: 'response',
            requestId: message.requestId,
            ok: false,
            error: safeError(error),
        });
    }
});

process.send?.({ kind: 'ready', processId, capabilities });
