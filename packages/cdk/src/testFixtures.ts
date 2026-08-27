/**
 * Shared snapshot-test fixtures for the `@mcp-savvy/cdk` constructs.
 *
 * Every construct that wraps an `IdentityProvider` (Runtime, Gateway,
 * future ApiGatewayFrontDoor, …) follows the same pattern: synthesize
 * a stack with a Cognito IdP, and another with an external-OIDC IdP
 * carrying the Entra-flavored `azp` custom claim. Centralizing the
 * setup keeps every construct's tests focused on its own assertions.
 *
 * Excluded from build + coverage by project convention; only test
 * files import from here.
 */

import * as cdk from 'aws-cdk-lib';
import { CognitoAuth } from './cognitoAuth.js';
import {
    externalOidc,
    type ExternalOidcIdentityProvider,
} from './identity/identityProvider.js';

/** Stable fake AWS account used across all snapshot tests. */
export const TEST_ACCOUNT = '111111111111';
/** Stable region used across all snapshot tests. */
export const TEST_REGION = 'us-east-1';
/** Stable Hosted UI domain prefix used across all snapshot tests. */
export const TEST_DOMAIN_PREFIX = 'mcp-savvy-test';

/**
 * Create a fresh `cdk.Stack` with the canonical (account, region) pair.
 * Defaults to id `'TestStack'`; override per test for clarity.
 */
export function freshStack(id = 'TestStack'): cdk.Stack {
    const app = new cdk.App();
    return new cdk.Stack(app, id, {
        env: { account: TEST_ACCOUNT, region: TEST_REGION },
    });
}

/**
 * Build a stack with a `CognitoAuth` already wired up. Returned alongside
 * the auth instance so individual tests can attach the construct under
 * test (Runtime, Gateway, …) and synthesize.
 */
export function stackWithCognitoAuth(
    id = 'CognitoCase',
): { stack: cdk.Stack; auth: CognitoAuth } {
    const stack = freshStack(id);
    const auth = new CognitoAuth(stack, 'Auth', { domainPrefix: TEST_DOMAIN_PREFIX });
    return { stack, auth };
}

/** Stable Entra fixture values — shared across every construct test. */
export const ENTRA_TENANT_ID = '00000000-0000-0000-0000-000000000000';
export const ENTRA_CLIENT_ID = '11111111-1111-1111-1111-111111111111';

/**
 * Canonical external-OIDC IdP fixture: Entra v2.0 issuer, audience +
 * azp custom-claim bound to the same client ID. Mirrors the real
 * Entra app-reg shape documented in `examples/identity-providers/entra.md`.
 */
export function entraIdentityProvider(): ExternalOidcIdentityProvider {
    return externalOidc({
        issuer: `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0`,
        allowedAudience: [ENTRA_CLIENT_ID],
        customClaim: { name: 'azp', value: ENTRA_CLIENT_ID },
    });
}

/**
 * Build a stack with the Entra `externalOidc` provider pre-built.
 * Returned alongside the IdP so individual tests can attach a Runtime
 * or Gateway under test and synthesize.
 */
export function stackWithEntraIdp(
    id = 'EntraCase',
): { stack: cdk.Stack; idp: ExternalOidcIdentityProvider } {
    return { stack: freshStack(id), idp: entraIdentityProvider() };
}
