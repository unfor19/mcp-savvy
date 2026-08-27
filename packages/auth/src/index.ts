/**
 * Public surface of `@mcp-savvy/auth`.
 */

export type { AuthProvider, AuthorizePrep, ExchangeCodeInput } from './types.js';
export { generatePkce, generateState, base64Url } from './pkce.js';
export type { PkceBundle } from './pkce.js';
export { fetchOIDC, discoveryUrl, filterScopes } from './oidc.js';
export type { OIDCDiscoveryDocument } from './oidc.js';
export { nodeFetcher } from './http.js';
export type { Fetcher, FetchRequest, FetchResponse } from './http.js';
export {
    OidcPkceProvider,
    CognitoProvider,
    cognitoIssuer,
} from './providers/index.js';
export type {
    OidcPkceProviderOptions,
    CognitoProviderOptions,
} from './providers/index.js';
export {
    completeGatewaySession,
    DEFAULT_3LO_CALLBACK_PATH,
    DEFAULT_3LO_CALLBACK_PORT,
} from './gatewaySession/index.js';
export type {
    CompleteGatewaySessionInput,
    CompleteGatewaySessionResult,
} from './gatewaySession/index.js';
