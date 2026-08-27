/** Regression tests for credential isolation in the immutable npm release path. */

import { describe, expect, it } from 'vitest';
import {
    installEnvironment,
    publishEnvironment,
    releaseEnvironment,
} from './release-cli.mjs';

const BUILD_SECRET = ['must', 'not', 'reach', 'build'].join('-');
const SOURCE = {
    PATH: '/tools',
    HOME: '/real-home',
    AWS_ACCESS_KEY_ID: BUILD_SECRET,
    GITHUB_TOKEN: BUILD_SECRET,
    NODE_AUTH_TOKEN: BUILD_SECRET,
    NPM_TOKEN: BUILD_SECRET,
    MCP_SAVVY_CLIENT_ID: BUILD_SECRET,
    OTP: 'must-not-be-forwarded',
    HTTPS_PROXY: 'https://proxy.example.com',
};

describe('releaseEnvironment', () => {
    it('uses a temporary home and excludes publishing, cloud, and application credentials', () => {
        const env = releaseEnvironment(SOURCE, '/isolated-home');
        expect(env).toMatchObject({
            PATH: '/tools',
            HOME: '/isolated-home',
            USERPROFILE: '/isolated-home',
            RELEASE_ISOLATED: '1',
        });
        expect(JSON.stringify(env)).not.toContain('must-not-reach-build');
        expect(JSON.stringify(env)).not.toContain('must-not-be-forwarded');
        expect(env).not.toHaveProperty('HTTPS_PROXY');
    });
});

describe('installEnvironment', () => {
    it('passes network settings only to the lifecycle-script-free install phase', () => {
        const env = installEnvironment(SOURCE, '/isolated-home');
        expect(env.HTTPS_PROXY).toBe('https://proxy.example.com');
        expect(JSON.stringify(env)).not.toContain(BUILD_SECRET);
    });
});

describe('publishEnvironment', () => {
    it('keeps only npm authentication and process essentials for the final publish', () => {
        const env = publishEnvironment(SOURCE);
        expect(env).toMatchObject({
            PATH: '/tools',
            HOME: '/real-home',
            NODE_AUTH_TOKEN: BUILD_SECRET,
            NPM_TOKEN: BUILD_SECRET,
        });
        expect(env).not.toHaveProperty('AWS_ACCESS_KEY_ID');
        expect(env).not.toHaveProperty('GITHUB_TOKEN');
        expect(env).not.toHaveProperty('MCP_SAVVY_CLIENT_ID');
        expect(env).not.toHaveProperty('OTP');
    });
});
