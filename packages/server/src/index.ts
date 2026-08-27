/**
 * Public surface of `@mcp-savvy/server`.
 */

export {
    CallbackServer,
    DEFAULT_CALLBACK_PORT,
    DEFAULT_CALLBACK_PATH,
} from './callbackServer.js';
export type {
    CallbackResult,
    CallbackServerOptions,
    AwaitCallbackOptions,
} from './callbackServer.js';
export { renderCallbackPage } from './templates.js';
export type { CallbackPageInput, CallbackPageKind } from './templates.js';
export { escapeHtml } from './escape.js';
