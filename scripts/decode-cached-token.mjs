#!/usr/bin/env node
/**
 * Decode the cached access token for an issuer+clientId. Lets us see
 * the actual JWT claims (iss / aud / azp / appid / ver) when an IdP
 * surprises us. Reads MCP_SAVVY_OIDC_ISSUER and MCP_SAVVY_CLIENT_ID
 * from the env (the same vars the CLI uses).
 */

import { resolveTokenStore } from '../packages/storage/dist/index.js';
import { deriveNamespace } from '../packages/cli/dist/namespace.js';

const issuer = process.env.MCP_SAVVY_OIDC_ISSUER;
const clientId = process.env.MCP_SAVVY_CLIENT_ID;
if (!issuer || !clientId) {
    console.error('missing MCP_SAVVY_OIDC_ISSUER or MCP_SAVVY_CLIENT_ID');
    process.exit(2);
}

const namespace = process.env.MCP_SAVVY_TOKEN_NAMESPACE ?? deriveNamespace(issuer, clientId);
const store = resolveTokenStore({ namespace });
const tokens = await store.get();
if (!tokens) {
    console.error('no cached tokens for namespace:', namespace);
    process.exit(1);
}

function decodeJwt(token) {
    const parts = token.split('.');
    if (parts.length !== 3) return { error: 'not a JWT' };
    const decode = (p) => JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return { header: decode(parts[0]), payload: decode(parts[1]) };
}

console.log('namespace:', namespace);
console.log();
console.log('=== access_token ===');
console.log(JSON.stringify(decodeJwt(tokens.access_token), null, 2));
if (tokens.id_token) {
    console.log();
    console.log('=== id_token ===');
    console.log(JSON.stringify(decodeJwt(tokens.id_token), null, 2));
}
