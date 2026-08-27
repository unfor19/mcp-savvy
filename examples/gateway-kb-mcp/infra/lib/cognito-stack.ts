import * as cdk from 'aws-cdk-lib';
import { CognitoAuth } from '@mcp-savvy/cdk';
import { Construct } from 'constructs';

/** Inputs for the gateway-kb-mcp Cognito stack. */
export interface CognitoStackProps extends cdk.StackProps {
    /** Globally-unique Hosted UI domain prefix. */
    readonly domainPrefix: string;
    /** MFA on by default; set to `false` only for low-friction demos. */
    readonly mfaRequired?: boolean;
}

/**
 * Cognito user pool for the gateway-kb-mcp demo. Thin wrapper around
 * `@mcp-savvy/cdk`'s `CognitoAuth` — same shape as the other
 * examples so the IdP-swap story stays identical.
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
            userPoolName: 'mcp-savvy-gateway-kb-demo',
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

        cdk.Tags.of(this).add('Project', 'mcp-savvy-gateway-kb-demo');
    }
}
