/**
 * `@mcp-savvy/cdk` — opinionated CDK constructs for shipping
 * protected MCP servers on AWS.
 *
 * Public surface:
 *   - `IdentityProvider` (type) + `externalOidc(...)` factory
 *   - vendor presets: `entraExternalOidc`, `oktaExternalOidc`,
 *     `auth0ExternalOidc`, `keycloakExternalOidc`
 *   - `importCognito(...)` bring-your-own-pool factory
 *   - `CognitoAuth` construct (the bundled IdP for demos)
 *   - `AgentCoreRuntime` construct (MCP-protocol AgentCore runtime
 *     gated by an `IdentityProvider`)
 *   - `AgentCoreGateway` construct (AgentCore Gateway gated by an
 *     `IdentityProvider`; target factories inherited from the L2)
 *
 * Future v0.3+ additions: `BedrockKnowledgeBase`,
 * `ApiGatewayFrontDoor`, `NetworkHardening`.
 */

export type {
    IdentityProvider,
    IdentityProviderBase,
    CognitoIdentityProvider,
    ExternalOidcIdentityProvider,
    JwtAuthorizerSpec,
    CustomClaimRule,
    ImportCognitoOptions,
} from './identity/identityProvider.js';
export { externalOidc, importCognito } from './identity/identityProvider.js';

export {
    entraExternalOidc,
    oktaExternalOidc,
    auth0ExternalOidc,
    keycloakExternalOidc,
} from './identity/idpPresets.js';
export type {
    EntraOidcOptions,
    OktaOidcOptions,
    Auth0OidcOptions,
    KeycloakOidcOptions,
} from './identity/idpPresets.js';

export { CognitoAuth } from './cognitoAuth.js';
export type { CognitoAuthProps } from './cognitoAuth.js';

export { AgentCoreRuntime } from './agentCoreRuntime.js';
export type { AgentCoreRuntimeProps } from './agentCoreRuntime.js';

export { AgentCoreGateway } from './agentCoreGateway.js';
export type { AgentCoreGatewayProps } from './agentCoreGateway.js';

export { OAuthCompleteSessionApi } from './oauthCompleteSessionApi/index.js';
export type { OAuthCompleteSessionApiProps } from './oauthCompleteSessionApi/index.js';

export { BedrockKnowledgeBase } from './bedrockKnowledgeBase/index.js';
export type {
    BedrockKnowledgeBaseProps,
    ChunkingConfig,
    KbCorpusSource,
} from './bedrockKnowledgeBase/index.js';
