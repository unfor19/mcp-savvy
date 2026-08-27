#!/usr/bin/env node
/**
 * Append a callback URL to the chatgpt-app-mcp Cognito client.
 *
 * Reads the existing client config via `aws cognito-idp describe-user-pool-client`,
 * appends the callback URL to its `CallbackURLs` list (deduplicated),
 * then writes the full payload back via `update-user-pool-client
 * --cli-input-json`. The full-payload approach is mandatory:
 * `update-user-pool-client` resets any field not explicitly provided
 * to its default, which would silently undo the L2 CognitoAuth
 * construct's `PreventUserExistenceErrors`, token validity settings,
 * OAuth scopes, etc.
 *
 * Required env vars: `USER_POOL`, `CLIENT`, `CALLBACK`. Optional:
 * `AWS_PROFILE`, `AWS_REGION`.
 */

import { env, exit, stderr, stdout } from 'node:process';

import { aws } from './aws.mjs';

const required = ['USER_POOL', 'CLIENT', 'CALLBACK'];
for (const key of required) {
    if (!env[key]) {
        stderr.write(`Missing required env var: ${key}\n`);
        exit(1);
    }
}

/** Read the current client. Returns the inner `UserPoolClient` object. */
function describeClient() {
    const out = aws([
        'cognito-idp', 'describe-user-pool-client',
        '--user-pool-id', env.USER_POOL,
        '--client-id', env.CLIENT,
        '--output', 'json',
    ]);
    return JSON.parse(out).UserPoolClient;
}

/** Build the update payload by preserving fields we read back. */
function buildUpdatePayload(client, callbackUrls) {
    const payload = {
        UserPoolId: env.USER_POOL,
        ClientId: env.CLIENT,
        CallbackURLs: callbackUrls,
    };
    const preserve = [
        'ClientName', 'AllowedOAuthFlows', 'AllowedOAuthScopes',
        'AllowedOAuthFlowsUserPoolClient', 'SupportedIdentityProviders',
        'ExplicitAuthFlows', 'AccessTokenValidity', 'IdTokenValidity',
        'RefreshTokenValidity', 'TokenValidityUnits',
        'PreventUserExistenceErrors', 'EnableTokenRevocation',
        'AuthSessionValidity', 'LogoutURLs', 'ReadAttributes',
        'WriteAttributes', 'DefaultRedirectURI',
    ];
    for (const key of preserve) {
        const value = client[key];
        if (value !== undefined && value !== null) {
            payload[key] = value;
        }
    }
    return payload;
}

const client = describeClient();
const existing = Array.isArray(client.CallbackURLs) ? [...client.CallbackURLs] : [];

if (existing.includes(env.CALLBACK)) {
    stdout.write(`Callback already registered: ${env.CALLBACK}\n`);
    exit(0);
}

const updated = [...existing, env.CALLBACK];
const payload = buildUpdatePayload(client, updated);

aws(['cognito-idp', 'update-user-pool-client', '--cli-input-json', JSON.stringify(payload)]);

stdout.write(`\n  Added: ${env.CALLBACK}\n  Cognito client now allows:\n`);
for (const url of updated) {
    stdout.write(`    - ${url}\n`);
}
