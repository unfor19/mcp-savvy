/**
 * Cognito stack for the chatgpt-app-mcp example.
 *
 * Wraps `@mcp-savvy/cdk`'s `CognitoAuth` construct with
 * banking-grade defaults: MFA TOTP **required** (no opt-out), public
 * PKCE client (no secret), email-only sign-in. The MCP Lambda
 * (lands in step 4) validates the resulting JWT in-process; ChatGPT
 * and the local `mcp-savvy` bridge reach the Hosted UI from a
 * public-client posture.
 *
 * Step 5 adds a custom Cognito Resource Server so access tokens
 * carry the scope `mcp-savvy.chatgpt-app/balance.read`. The MCP
 * Lambda's auth path enforces this scope on `/mcp` calls. The L2
 * `CognitoAuth` client only allows the standard
 * OAuth scopes; we extend its `AllowedOAuthScopes` via a property
 * override; the reason is documented next to the override.
 *
 * The Hosted UI domain prefix must be globally unique within the
 * chosen region — pass it explicitly via `MCP_SAVVY_CHATGPT_APP_DOMAIN_PREFIX`
 * if the default `mcp-savvy-chatgpt-app` clashes with a prior demo.
 *
 * Why no `mfaRequired: off` env switch (in contrast to other
 * examples): the whole point of this example is the secure-widget
 * pattern around sensitive financial data. Optional MFA would
 * undermine the threat model — see SECURITY.md section 1.2.
 */

import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { CognitoAuth } from '@mcp-savvy/cdk';
import { Construct } from 'constructs';

/**
 * Cognito custom-scope name (without the resource-server prefix).
 * The full wire form is `${resourceIdentifier}/${BALANCE_READ_SCOPE_NAME}`,
 * where `resourceIdentifier` is passed in via stack props (the
 * public API URL). RFC 8707 Resource Indicators: ChatGPT
 * sends `resource=<url>` alongside `scope=<url>/balance.read`, and
 * Cognito requires the scope's resource server identifier to match.
 */
export const BALANCE_READ_SCOPE_NAME = 'balance.read';

/** Inputs for the chatgpt-app-mcp Cognito stack. */
export interface CognitoStackProps extends cdk.StackProps {
    /** Globally-unique Hosted UI domain prefix in the chosen region. */
    readonly domainPrefix: string;
    /**
     * Resource server identifier — the URL ChatGPT sends as the
     * `resource` parameter (RFC 8707). Cognito requires the
     * resource server identifier to match for custom scopes to be
     * granted. Typically the public API custom-domain URL.
     */
    readonly resourceIdentifier: string;
}

/**
 * User pool + Hosted UI + public PKCE client for the chatgpt-app-mcp
 * banking-grade demo. MFA TOTP is non-negotiable.
 */
export class CognitoStack extends cdk.Stack {
    public readonly auth: CognitoAuth;
    /** Resource server hosting the `balance.read` custom scope. */
    public readonly resourceServer: cognito.UserPoolResourceServer;
    /** Wire form of the scope, e.g. `https://d12345.cloudfront.net/balance.read`. */
    public readonly balanceReadScopeFull: string;

    constructor(scope: Construct, id: string, props: CognitoStackProps) {
        super(scope, id, props);

        this.balanceReadScopeFull = `${props.resourceIdentifier}/${BALANCE_READ_SCOPE_NAME}`;

        this.auth = new CognitoAuth(this, 'Auth', {
            domainPrefix: props.domainPrefix,
            userPoolName: 'mcp-savvy-chatgpt-app',
            mfaRequired: true,
        });

        const balanceReadScope = new cognito.ResourceServerScope({
            scopeName: BALANCE_READ_SCOPE_NAME,
            scopeDescription: 'Read the signed-in user\'s credit balance.',
        });
        this.resourceServer = this.auth.userPool.addResourceServer('McpResourceServer', {
            userPoolResourceServerName: 'mcp-savvy chatgpt-app MCP server',
            identifier: props.resourceIdentifier,
            scopes: [balanceReadScope],
        });

        // The L2 `CognitoAuth` human-client allows openid + email +
        // profile only. Extend its AllowedOAuthScopes so the bridge can
        // request the custom scope. CDK's `addPropertyOverride` replaces
        // (not merges), so we re-list the standard scopes alongside the
        // new one — same shape the L2 emits, plus our addition. Updating
        // the L2 directly would force every example to take the change;
        // the override keeps it scoped to this stack.
        const cfnClient = this.auth.humanClient.node.defaultChild as cognito.CfnUserPoolClient;
        cfnClient.addPropertyOverride('AllowedOAuthScopes', [
            cognito.OAuthScope.OPENID.scopeName,
            cognito.OAuthScope.EMAIL.scopeName,
            cognito.OAuthScope.PROFILE.scopeName,
            this.balanceReadScopeFull,
        ]);
        // The override lands at synth time, but the resource-server
        // resource itself must exist before the client references its
        // scope — wire the dependency explicitly.
        cfnClient.addDependency(this.resourceServer.node.defaultChild as cdk.CfnResource);

        new cdk.CfnOutput(this, 'UserPoolId', {
            value: this.auth.userPool.userPoolId,
            description: 'Cognito user pool ID',
        });
        new cdk.CfnOutput(this, 'IssuerUrl', {
            value: this.auth.issuerUrl,
            description: 'OIDC issuer URL — set as MCP_SAVVY_OIDC_ISSUER',
        });
        new cdk.CfnOutput(this, 'HostedUiUrl', {
            value: this.auth.hostedUiUrl,
            description: 'Cognito Hosted UI base URL',
        });
        new cdk.CfnOutput(this, 'HumanClientId', {
            value: this.auth.humanClient.userPoolClientId,
            description: 'Public PKCE client ID — set as MCP_SAVVY_CLIENT_ID',
        });
        new cdk.CfnOutput(this, 'BalanceReadScope', {
            value: this.balanceReadScopeFull,
            description: 'Custom OAuth scope required on every /mcp call.',
        });

        cdk.Tags.of(this).add('Project', 'mcp-savvy-chatgpt-app');
    }
}
