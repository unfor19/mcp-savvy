/**
 * Library exports for advanced consumers who want to compose
 * `mcp-savvy` programmatically (the integrator API documented in README.md
 * section 4.3). End users of the CLI just run `npx -y mcp-savvy`.
 */

export { loadConfig, type CliConfig } from './env.js';
export {
    DEFAULT_SCOPES,
    DEFAULT_CALLBACK_PORT,
    DEFAULT_CALLBACK_PATH,
} from './env.js';
export { deriveNamespace } from './namespace.js';
export { TokenManager } from './tokens/index.js';
export type { TokenManagerOptions, AuthorizeBrowser } from './tokens/index.js';
export {
    runBridge,
    login,
    logout,
    printEnv,
    redact,
    type CommandDeps,
} from './commands/index.js';
export {
    main,
    parseArgs,
    buildDeps,
    dispatch,
    type Command,
} from './cli.js';
