/**
 * Unit tests for the vendor IdP presets.
 *
 * Each preset is a thin wrapper over `externalOidc`; these tests pin
 * the per-IdP quirks that make tokens validate: the issuer URL shape,
 * the default audience, and which claim carries the client ID
 * (Entra/Auth0/Keycloak → `azp`, Okta → `cid`).
 */

import { describe, expect, it } from 'vitest';
import {
    auth0ExternalOidc,
    entraExternalOidc,
    keycloakExternalOidc,
    oktaExternalOidc,
} from './idpPresets.js';

describe('entraExternalOidc', () => {
    const TENANT = '00000000-0000-0000-0000-000000000000';
    const CLIENT = '11111111-1111-1111-1111-111111111111';

    it('builds the v2 issuer URL from the tenant', () => {
        const idp = entraExternalOidc({ tenantId: TENANT, clientId: CLIENT });
        expect(idp.issuerUrl).toBe(`https://login.microsoftonline.com/${TENANT}/v2.0`);
        expect(idp.jwtAuthorizer.discoveryUrl).toBe(
            `https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`,
        );
    });

    it('defaults audience to clientId and pins azp to clientId', () => {
        const idp = entraExternalOidc({ tenantId: TENANT, clientId: CLIENT });
        expect(idp.jwtAuthorizer.allowedAudience).toEqual([CLIENT]);
        expect(idp.jwtAuthorizer.customClaim).toEqual({ name: 'azp', value: CLIENT });
    });

    it('does NOT set allowedClients (v2 tokens do not carry client_id)', () => {
        const idp = entraExternalOidc({ tenantId: TENANT, clientId: CLIENT });
        expect(idp.jwtAuthorizer.allowedClients).toBeUndefined();
    });

    it('honors an explicit audience override (resource-server case)', () => {
        const idp = entraExternalOidc({
            tenantId: TENANT,
            clientId: CLIENT,
            audience: `api://${CLIENT}`,
        });
        expect(idp.jwtAuthorizer.allowedAudience).toEqual([`api://${CLIENT}`]);
        // azp still binds to the bare client ID even when audience differs.
        expect(idp.jwtAuthorizer.customClaim).toEqual({ name: 'azp', value: CLIENT });
    });
});

describe('oktaExternalOidc', () => {
    const CLIENT = '0oa1bcdefghIJKLmn0p7';

    it('builds the default custom-auth-server issuer from a bare domain', () => {
        const idp = oktaExternalOidc({ domain: 'dev-123.okta.com', clientId: CLIENT });
        expect(idp.issuerUrl).toBe('https://dev-123.okta.com/oauth2/default');
        expect(idp.jwtAuthorizer.discoveryUrl).toBe(
            'https://dev-123.okta.com/oauth2/default/.well-known/openid-configuration',
        );
    });

    it('strips a scheme prefix and trailing slash from the domain', () => {
        const idp = oktaExternalOidc({ domain: 'https://dev-123.okta.com/', clientId: CLIENT });
        expect(idp.issuerUrl).toBe('https://dev-123.okta.com/oauth2/default');
    });

    it('binds the client to the cid claim (not azp / client_id)', () => {
        const idp = oktaExternalOidc({ domain: 'dev-123.okta.com', clientId: CLIENT });
        expect(idp.jwtAuthorizer.customClaim).toEqual({ name: 'cid', value: CLIENT });
        expect(idp.jwtAuthorizer.allowedClients).toBeUndefined();
    });

    it('defaults the audience to api://default', () => {
        const idp = oktaExternalOidc({ domain: 'dev-123.okta.com', clientId: CLIENT });
        expect(idp.jwtAuthorizer.allowedAudience).toEqual(['api://default']);
    });

    it('honors a non-default authorization server and audience', () => {
        const idp = oktaExternalOidc({
            domain: 'dev-123.okta.com',
            clientId: CLIENT,
            authorizationServerId: 'aus9xyz',
            audience: 'https://mcp.example.com',
        });
        expect(idp.issuerUrl).toBe('https://dev-123.okta.com/oauth2/aus9xyz');
        expect(idp.jwtAuthorizer.allowedAudience).toEqual(['https://mcp.example.com']);
    });
});

describe('auth0ExternalOidc', () => {
    const CLIENT = 'auth0ClientId123';
    const AUDIENCE = 'https://mcp.example.com';

    it('builds the issuer from the domain (no trailing slash stored)', () => {
        const idp = auth0ExternalOidc({
            domain: 'my-tenant.us.auth0.com',
            clientId: CLIENT,
            audience: AUDIENCE,
        });
        expect(idp.issuerUrl).toBe('https://my-tenant.us.auth0.com');
        expect(idp.jwtAuthorizer.discoveryUrl).toBe(
            'https://my-tenant.us.auth0.com/.well-known/openid-configuration',
        );
    });

    it('requires + forwards the audience and binds the client to azp', () => {
        const idp = auth0ExternalOidc({
            domain: 'my-tenant.us.auth0.com',
            clientId: CLIENT,
            audience: AUDIENCE,
        });
        expect(idp.jwtAuthorizer.allowedAudience).toEqual([AUDIENCE]);
        expect(idp.jwtAuthorizer.customClaim).toEqual({ name: 'azp', value: CLIENT });
    });

    it('accepts a full https domain URL', () => {
        const idp = auth0ExternalOidc({
            domain: 'https://my-tenant.us.auth0.com/',
            clientId: CLIENT,
            audience: AUDIENCE,
        });
        expect(idp.issuerUrl).toBe('https://my-tenant.us.auth0.com');
    });
});

describe('keycloakExternalOidc', () => {
    const CLIENT = 'mcp-client';

    it('builds the realm issuer URL from base + realm', () => {
        const idp = keycloakExternalOidc({
            baseUrl: 'https://keycloak.example.com',
            realm: 'my-realm',
            clientId: CLIENT,
        });
        expect(idp.issuerUrl).toBe('https://keycloak.example.com/realms/my-realm');
        expect(idp.jwtAuthorizer.discoveryUrl).toBe(
            'https://keycloak.example.com/realms/my-realm/.well-known/openid-configuration',
        );
    });

    it('strips a trailing slash from the base URL', () => {
        const idp = keycloakExternalOidc({
            baseUrl: 'https://keycloak.example.com/',
            realm: 'my-realm',
            clientId: CLIENT,
        });
        expect(idp.issuerUrl).toBe('https://keycloak.example.com/realms/my-realm');
    });

    it('skips audience validation by default and binds the client to azp', () => {
        const idp = keycloakExternalOidc({
            baseUrl: 'https://keycloak.example.com',
            realm: 'my-realm',
            clientId: CLIENT,
        });
        expect(idp.jwtAuthorizer.allowedAudience).toBeUndefined();
        expect(idp.jwtAuthorizer.customClaim).toEqual({ name: 'azp', value: CLIENT });
    });

    it('sets the audience when an audience mapper value is provided', () => {
        const idp = keycloakExternalOidc({
            baseUrl: 'https://keycloak.example.com',
            realm: 'my-realm',
            clientId: CLIENT,
            audience: 'mcp-api',
        });
        expect(idp.jwtAuthorizer.allowedAudience).toEqual(['mcp-api']);
    });
});
