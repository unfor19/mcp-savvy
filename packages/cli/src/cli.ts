#!/usr/bin/env node
/**
 * `mcp-savvy` binary entrypoint.
 *
 * Parses argv into one of four commands (run-bridge / --login /
 * --logout / --print-env), wires up the production dependencies,
 * dispatches to a command handler in `commands.ts`, and exits with
 * the returned code.
 *
 * Keep this file small. The real logic lives in `commands.ts` and
 * `tokenManager.ts` so it can be unit-tested without a subprocess.
 */

import { createLogger, McpSavvyError } from '@mcp-savvy/core';
import { CognitoProvider, OidcPkceProvider } from '@mcp-savvy/auth';
import { resolveTokenStore, LockCoordinator } from '@mcp-savvy/storage';
import { CallbackServer } from '@mcp-savvy/server';
import {
    StdioBridge,
    composeRequestInterceptors,
    composeResponseInterceptors,
    gatewaySessionInterceptor,
    passThroughInterceptor,
    passThroughRequestInterceptor,
    searchFirstInterceptors,
    type RequestInterceptor,
    type ResponseInterceptor,
} from '@mcp-savvy/bridge';
import { loadConfig, type CliConfig } from './env.js';
import { deriveNamespace } from './namespace.js';
import {
    runBridge,
    login,
    forceLogin,
    logout,
    printEnv,
    type CommandDeps,
} from './commands/index.js';
import type { TokenProvider } from '@mcp-savvy/bridge';
import { exitCodeForError } from './runtime/exitCode.js';
import { defaultOpenBrowser } from './runtime/openBrowser.js';
import { Cli } from './runtime/cliRuntime.js';
import { setCliInstance } from './runtime/signalHandlers.js';

// Importing `./signalHandlers.js` above installs module-load handlers
// for SIGINT/SIGTERM/SIGHUP/uncaughtException. `main` registers the
// live `Cli` runtime so those handlers can find the resources to
// release on shutdown.

const USAGE = `mcp-savvy — protected MCP stdio bridge

Usage: npx -y mcp-savvy [--login | --force-login | --logout | --print-env | --help]

  --login / --force-login / --logout / --print-env — see README.md for behavior.

Required env vars:
  MCP_SAVVY_REMOTE_URL    Streamable-HTTP MCP endpoint
  MCP_SAVVY_OIDC_ISSUER   OIDC issuer URL
  MCP_SAVVY_CLIENT_ID     OIDC client ID (public, no secret)

Optional env vars:
  MCP_SAVVY_PROVIDER       'cognito' (default) | 'oidc'
  MCP_SAVVY_SCOPES         OAuth scopes (default: 'openid email profile')
  MCP_SAVVY_CALLBACK_HOST  'localhost' (default) | '127.0.0.1'
  MCP_SAVVY_CALLBACK_PORT  Loopback port (default: 33423)
  MCP_SAVVY_CALLBACK_PATH  Callback path (default: '/callback')
  MCP_SAVVY_TOKEN_NAMESPACE  Override the keychain namespace
  MCP_SAVVY_BRAND_NAME     Brand label on the callback page
  MCP_SAVVY_COMPLETE_SESSION_URL  AgentCore Gateway 3LO completion endpoint
  MCP_SAVVY_TOOL_MODE      'passthrough' (default) | 'search-local' | 'search-gateway'
  MCP_SAVVY_TOOL_PREFIX    Prefix for synthetic tools in search-* modes (default 'mcp_savvy')
  MCP_SAVVY_DEBUG          '1' to enable debug logging
  MCP_SAVVY_LOG            'json' or 'text' (default: text)
`;

/** Parse argv (after `node` and the script path) into a command name. */
export type Command = 'run' | 'login' | 'force-login' | 'logout' | 'print-env' | 'help';

/** Parse a flag list into a single command. Multiple flags = error. */
export function parseArgs(argv: readonly string[]): Command {
    const flags = argv.filter((a) => a.startsWith('-'));
    if (flags.length === 0) return 'run';
    if (flags.length > 1) {
        throw new McpSavvyError(
            'CONFIG_INVALID',
            `expected at most one flag, got: ${flags.join(' ')}`,
        );
    }
    const flag = flags[0];
    switch (flag) {
        case '--help':
        case '-h':
            return 'help';
        case '--login':
            return 'login';
        case '--force-login':
            return 'force-login';
        case '--logout':
            return 'logout';
        case '--print-env':
            return 'print-env';
        default:
            throw new McpSavvyError('CONFIG_INVALID', `unknown flag: ${flag}`);
    }
}

/** Build the production dependency set from a config. */
export function buildDeps(config: CliConfig): CommandDeps {
    const namespace = config.tokenNamespace ?? deriveNamespace(config.issuer, config.clientId);
    const logger = createLogger({ name: 'mcp-savvy', level: config.debug ? 'debug' : 'info' });
    const store = resolveTokenStore({ namespace, dataDir: config.dataDir }, logger);
    // Single shared cross-process mutex. Phase 5 commands and Phase 7
    // `Cli.cleanup` release outstanding handles through this instance.
    const lock = new LockCoordinator({
        dataDir: config.dataDir,
        stalenessThresholdMs: config.lockStaleMs,
        logger,
    });
    const redirectUri = `http://${config.callbackHost}:${config.callbackPort}${config.callbackPath}`;
    const auth =
        config.provider === 'cognito'
            ? new CognitoProvider({
                issuer: config.issuer,
                clientId: config.clientId,
                redirectUri,
                scopes: config.scopes,
            })
            : new OidcPkceProvider({
                issuer: config.issuer,
                clientId: config.clientId,
                redirectUri,
                scopes: config.scopes,
            });
    const createCallbackServer = (): CallbackServer =>
        new CallbackServer({
            host: config.callbackHost as 'localhost' | '127.0.0.1',
            port: config.callbackPort,
            expectedPath: config.callbackPath,
            ...(config.brandName !== undefined ? { brandName: config.brandName } : {}),
            logger,
        });
    const createBridge = (getAccessToken: TokenProvider): StdioBridge => {
        const gatewayInterceptor = config.completeSessionUrl
            ? gatewaySessionInterceptor({
                completeSessionEndpoint: config.completeSessionUrl,
                getUserToken: async () =>
                    getAccessToken({ forceRefresh: false }),
                openBrowser: defaultOpenBrowser,
                ...(config.brandName !== undefined ? { brandName: config.brandName } : {}),
                logger,
            })
            : undefined;

        // Tool-mode interceptors. Two synthetic
        // tools replace the upstream surface in either search-first
        // mode; passthrough leaves everything alone.
        const search =
            config.toolMode === 'search-local' || config.toolMode === 'search-gateway'
                ? searchFirstInterceptors({
                    mode: config.toolMode === 'search-local' ? 'local' : 'gateway',
                    prefix: config.toolPrefix,
                })
                : undefined;

        // Compose request + response chains. Search-first runs
        // first so synthetic tools are recognized before any other
        // interceptor (3LO retry should never see a synthetic tool
        // name; by the time gatewaySession's response interceptor
        // looks at a frame, the tool name has already been
        // rewritten upstream).
        const requestChain: RequestInterceptor[] = search ? [search.request] : [];
        const responseChain: ResponseInterceptor[] = [];
        if (search) responseChain.push(search.response);
        if (gatewayInterceptor) responseChain.push(gatewayInterceptor);

        const requestInterceptor =
            requestChain.length > 0
                ? composeRequestInterceptors(requestChain)
                : passThroughRequestInterceptor;
        const responseInterceptor =
            responseChain.length > 0
                ? composeResponseInterceptors(responseChain)
                : passThroughInterceptor;

        // AgentCore Gateway with 3LO targets requires
        // `mcp-protocol-version: 2025-11-25` on every request — the
        // service rejects 3LO target creation entirely without it
        // (`3LO authentication requires MCP version 2025-11-25 or
        // later`). When the 3LO interceptor is active, pin the
        // header so the SDK's negotiated default (`2025-06-18`)
        // doesn't reach the gateway.
        const mcpProtocolVersion = config.completeSessionUrl ? '2025-11-25' : undefined;
        return new StdioBridge({
            remoteUrl: config.remoteUrl,
            getAccessToken,
            logger,
            requestInterceptor,
            responseInterceptor,
            ...(mcpProtocolVersion ? { mcpProtocolVersion } : {}),
        });
    };
    return {
        auth,
        store,
        createCallbackServer,
        createBridge,
        logger,
        openBrowser: defaultOpenBrowser,
        lock,
        namespace,
        lockTimeoutMs: config.lockTimeoutMs,
    };
}

/** Dispatch a command to its handler. */
export async function dispatch(
    command: Command,
    config: CliConfig,
    deps: CommandDeps,
): Promise<number> {
    switch (command) {
        case 'help':
            process.stderr.write(USAGE);
            return 0;
        case 'run':
            return runBridge(config, deps);
        case 'login':
            return login(config, deps);
        case 'force-login':
            return forceLogin(config, deps);
        case 'logout':
            return logout(config, deps);
        case 'print-env':
            return printEnv(config, deps);
    }
}

/** Top-level entry. Catches all errors so the host sees a clean exit. */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
    let command: Command;
    try {
        command = parseArgs(argv);
    } catch (err) {
        process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
        return 2;
    }
    if (command === 'help') {
        process.stderr.write(USAGE);
        return 0;
    }
    let config: CliConfig;
    try {
        config = loadConfig(env);
    } catch (err) {
        process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
        return 2;
    }
    const deps = buildDeps(config);
    const cliInstance = new Cli();
    cliInstance.lock = deps.lock;
    setCliInstance(cliInstance);
    // TODO Phase 7.2 / runBridge: wire cliInstance.bridge and
    // cliInstance.callbackServer when those resources are constructed.
    try {
        return await dispatch(command, config, deps);
    } catch (err) {
        return exitCodeForError(err as Error, deps);
    }
}

// Run when invoked as a binary, but stay importable for tests.
// The import.meta.url check is the ESM idiom; the require.main check
// is the CJS equivalent for when tsup bundles to CJS format.
const isMain =
    (typeof require !== 'undefined' && require.main === module) ||
    (typeof import.meta !== 'undefined' && import.meta.url === `file://${process.argv[1]}`);

if (isMain) {
    main(process.argv.slice(2), process.env)
        .then((code) => process.exit(code))
        .catch((err) => {
            process.stderr.write(`unhandled: ${(err as Error).message}\n`);
            process.exit(1);
        });
}
