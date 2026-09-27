/** Cross-process acceptance test for serialized AgentCore session completion. */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const CHILD_TIMEOUT_MS = 10_000;
const CONTENTION_OBSERVATION_MS = 150;

function childSource(authModuleUrl) {
    return `
import { completeGatewaySession } from ${JSON.stringify(authModuleUrl)};
const sessionUri = process.env.SESSION_URI;
await completeGatewaySession({
    authorizationUrl: 'https://idp.example/authorize?request_uri=' + encodeURIComponent(sessionUri),
    completeSessionEndpoint: 'https://api.example/complete-session',
    callbackPort: Number(process.env.CALLBACK_PORT),
    timeoutMs: 5000,
    userToken: 'synthetic-user-token',
    openBrowser: async () => process.stdout.write('OPENED\\n'),
    fetcher: { fetch: async () => ({ status: 200, headers: {}, body: '' }) },
});
process.stdout.write('DONE\\n');
`;
}

async function freePort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing callback port');
    await new Promise((resolve, reject) =>
        server.close((err) => err ? reject(err) : resolve()),
    );
    return address.port;
}

function spawnCompletion(scriptPath, port, sessionUri) {
    const child = spawn(process.execPath, [scriptPath], {
        env: {
            ...process.env,
            CALLBACK_PORT: String(port),
            SESSION_URI: sessionUri,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const opened = waitForOutput(child, () => stdout.includes('OPENED\n'), () => stderr);
    const exited = new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    const guard = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
    guard.unref();
    void exited.then(() => clearTimeout(guard));
    return { child, opened, exited, get stdout() { return stdout; } };
}

function waitForOutput(child, predicate, stderr) {
    return new Promise((resolve, reject) => {
        const check = () => {
            if (!predicate()) return;
            cleanup();
            resolve();
        };
        const fail = (code, signal) => {
            cleanup();
            reject(new Error(`completion child exited before opening: code=${code} signal=${signal} stderr=${stderr() || '<empty>'}`));
        };
        const cleanup = () => {
            child.stdout.off('data', check);
            child.off('exit', fail);
        };
        child.stdout.on('data', check);
        child.once('exit', fail);
    });
}

async function finish(port, sessionUri) {
    const url = `http://127.0.0.1:${port}/oauth2/callback?session_id=${encodeURIComponent(sessionUri)}`;
    const response = await fetch(url, { redirect: 'error' });
    if (response.status !== 200) throw new Error(`callback returned HTTP ${response.status}`);
}

async function requireSuccess(result, label) {
    if (result.code !== 0 || result.signal !== null || !result.stdout.includes('DONE\n')) {
        throw new Error(`${label} failed: code=${result.code} signal=${result.signal} stderr=${result.stderr || '<empty>'}`);
    }
}

/** Run two complete AgentCore flows and prove the second browser waits for the first. */
export async function runAgentCoreSessionConcurrency({ tmpRoot, repoRoot }) {
    const authModuleUrl = pathToFileURL(path.join(repoRoot, 'packages/auth/dist/index.js')).href;
    const scriptPath = path.join(tmpRoot, 'agentcore-session-child.mjs');
    await writeFile(scriptPath, childSource(authModuleUrl), 'utf8');
    const port = await freePort();
    const firstSession = 'urn:ietf:params:oauth:request_uri:first';
    const secondSession = 'urn:ietf:params:oauth:request_uri:second';

    const first = spawnCompletion(scriptPath, port, firstSession);
    await first.opened;
    const second = spawnCompletion(scriptPath, port, secondSession);
    await sleep(CONTENTION_OBSERVATION_MS);
    if (second.stdout.includes('OPENED\n')) {
        throw new Error('second authorization browser opened before callback-port ownership');
    }

    await finish(port, firstSession);
    await requireSuccess(await first.exited, 'first completion');
    await second.opened;
    await finish(port, secondSession);
    await requireSuccess(await second.exited, 'second completion');
    process.stdout.write('  ✓ concurrent AgentCore sessions serialize before browser launch\n');
}
