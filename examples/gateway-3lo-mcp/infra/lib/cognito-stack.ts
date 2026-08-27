import * as cdk from 'aws-cdk-lib';
import { CognitoAuth } from '@mcp-savvy/cdk';
import { Construct } from 'constructs';

/** Inputs for the demo Cognito stack. */
export interface CognitoStackProps extends cdk.StackProps {
    /** Globally-unique Hosted UI domain prefix in the chosen region. */
    readonly domainPrefix: string;
    /**
     * Whether to require MFA on the user pool. Defaults to `true`
     * (TOTP-only). Set to `false` only for low-friction demos where
     * forcing TOTP enrollment is unwelcome — every other deployment
     * should keep MFA on.
     */
    readonly mfaRequired?: boolean;
}

/**
 * Cognito stack for the mcp-savvy gateway-3lo-mcp demo.
 *
 * Same shape as the gateway-lambda-mcp Cognito stack. Re-exports the
 * `CognitoAuth` instance as `auth` so the gateway stack can wire the
 * same identity provider to both the AgentCore Gateway and the
 * `OAuthCompleteSessionApi` that completes the second-leg flow.
 */
export class CognitoStack extends cdk.Stack {
    public readonly auth: CognitoAuth;

    constructor(scope: Construct, id: string, props: CognitoStackProps) {
        super(scope, id, props);

        const authProps: { domainPrefix: string; mfaRequired?: boolean } = {
            domainPrefix: props.domainPrefix,
        };
        if (props.mfaRequired !== undefined) authProps.mfaRequired = props.mfaRequired;
        this.auth = new CognitoAuth(this, 'Auth', {
            ...authProps,
            userPoolName: 'mcp-savvy-3lo-demo',
        });

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

        cdk.Tags.of(this).add('Project', 'mcp-savvy-3lo-demo');
    }
}
