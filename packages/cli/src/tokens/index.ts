/**
 * Token-management orchestration: cache → refresh → PKCE.
 */

export { TokenManager, REFRESH_BUFFER_MS, classifyCredential } from './manager.js';
export type {
    TokenManagerOptions,
    AuthorizeBrowser,
} from './manager.js';
export { createAuthDiagnosticEmitter } from './diagnostics.js';
export type {
    AuthDecisionReason,
    AuthDiagnosticEmitter,
    AuthDiagnosticEvent,
    CredentialDecisionReason,
    InteractiveSignInReason,
    RefreshDecisionReason,
} from './diagnostics.js';
