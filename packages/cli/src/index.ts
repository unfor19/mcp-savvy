/** Public configuration helpers for consumers embedding the CLI contract. */

export { loadConfig, type CliConfig } from './env.js';
export {
    DEFAULT_SCOPES,
    DEFAULT_CALLBACK_PORT,
    DEFAULT_CALLBACK_PATH,
} from './env.js';
export { deriveNamespace } from './namespace.js';
