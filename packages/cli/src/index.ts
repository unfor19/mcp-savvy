/** Public configuration helpers for consumers embedding the CLI contract. */

export { loadConfig, type CliConfig } from './env.js';
export {
    DEFAULT_SCOPES,
    DEFAULT_CALLBACK_PORT,
    DEFAULT_CALLBACK_PATH,
    DEFAULT_BEARER_PREFERENCE,
} from './env.js';
export type { BearerPreference } from './env.js';
export { deriveNamespace } from './namespace.js';
export {
    resolveEffectiveCacheIdentity,
    type EffectiveCacheIdentity,
    type EffectiveCacheIdentityInput,
} from './identity/index.js';
