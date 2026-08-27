/**
 * Token-management orchestration: cache → refresh → PKCE.
 */

export { TokenManager, REFRESH_BUFFER_MS } from './manager.js';
export type {
    TokenManagerOptions,
    AuthorizeBrowser,
} from './manager.js';
