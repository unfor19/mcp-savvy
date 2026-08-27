/**
 * `CognitoAuth` — opinionated, secure-by-default Cognito user pool
 * for protected MCP servers.
 */

import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import type { CognitoIdentityProvider, JwtAuthorizerSpec } from './identity/identityProvider.js';

/** Configuration for the bundled Cognito user pool. */
export interface CognitoAuthProps {
    /** Globally-unique Hosted UI domain prefix in the chosen region. */
    readonly domainPrefix: string;
    /**
     * Loopback callback URLs the Hosted UI is allowed to redirect to.
     * Defaults to mcp-savvy's port (33423) plus the legacy 33418, on
     * both `localhost` (project convention) and `127.0.0.1` (so the
     * literal-IP form also works for any client that prefers it).
     */
    readonly extraCallbackUrls?: string[];
    /**
     * Whether to require MFA. Defaults to `true` (TOTP only — no SMS
     * for security). Flip to `false` only for first-run demos where
     * forcing TOTP enrollment is unwelcome.
     */
    readonly mfaRequired?: boolean;
    /**
     * Whether to allow self-signup. Defaults to `false` so operators
     * onboard users explicitly via `admin-create-user`.
     */
    readonly selfSignUp?: boolean;
    /**
     * Cognito branding version. Defaults to `'modern'`
     * (`NEWER_MANAGED_LOGIN`); flip to `'classic'` only when a team
     * needs the legacy Hosted UI for parity with an existing deploy.
     */
    readonly managedLogin?: 'modern' | 'classic';
    /**
     * Friendly name for the user pool (also used as the human client
     * name with a `-human` suffix). Defaults to `'mcp-savvy'`.
     */
    readonly userPoolName?: string;
    /**
     * If `true`, the user pool is destroyed on `cdk destroy`. Demo
     * default is `true`; production should set `false`.
     */
    readonly destroyOnRemoval?: boolean;
}

const DEFAULT_CALLBACK_URLS = [
    'http://localhost:33423/callback',
    'http://127.0.0.1:33423/callback',
    'http://localhost:33418/callback',
    'http://127.0.0.1:33418/callback',
];

/**
 * Cognito user pool + public PKCE app client + Hosted UI domain,
 * pre-wired for `mcp-savvy`.
 *
 * Defaults: MFA required (TOTP only), self-signup disabled, modern
 * managed-login UI, password policy 12+ chars upper+lower+digit+symbol,
 * email-only account recovery, public PKCE client (no secret).
 *
 * The construct exposes itself as a `CognitoIdentityProvider` so other
 * constructs (e.g. `AgentCoreRuntime`) can consume it generically.
 */
export class CognitoAuth extends Construct implements CognitoIdentityProvider {
    public readonly kind = 'cognito' as const;
    public readonly userPool: cognito.UserPool;
    public readonly humanClient: cognito.UserPoolClient;
    public readonly issuerUrl: string;
    public readonly hostedUiUrl: string;
    public readonly jwtAuthorizer: JwtAuthorizerSpec;

    constructor(scope: Construct, id: string, props: CognitoAuthProps) {
        super(scope, id);

        const mfaRequired = props.mfaRequired ?? true;
        const selfSignUp = props.selfSignUp ?? false;
        const managedLogin = props.managedLogin ?? 'modern';
        const userPoolName = props.userPoolName ?? 'mcp-savvy';
        const destroyOnRemoval = props.destroyOnRemoval ?? true;

        this.userPool = new cognito.UserPool(this, 'UserPool', {
            userPoolName,
            selfSignUpEnabled: selfSignUp,
            signInAliases: { email: true, username: false },
            autoVerify: { email: true },
            standardAttributes: {
                email: { required: true, mutable: false },
            },
            passwordPolicy: {
                minLength: 12,
                requireLowercase: true,
                requireUppercase: true,
                requireDigits: true,
                requireSymbols: true,
                tempPasswordValidity: cdk.Duration.days(7),
            },
            mfa: mfaRequired ? cognito.Mfa.REQUIRED : cognito.Mfa.OPTIONAL,
            mfaSecondFactor: { sms: false, otp: true },
            accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
            removalPolicy: destroyOnRemoval
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
        });

        this.userPool.addDomain('Domain', {
            cognitoDomain: { domainPrefix: props.domainPrefix },
            managedLoginVersion:
                managedLogin === 'modern'
                    ? cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN
                    : cognito.ManagedLoginVersion.CLASSIC_HOSTED_UI,
        });

        const callbackUrls = props.extraCallbackUrls ?? DEFAULT_CALLBACK_URLS;

        this.humanClient = this.userPool.addClient('HumanClient', {
            userPoolClientName: `${userPoolName}-human`,
            generateSecret: false,
            authFlows: { userSrp: true },
            oAuth: {
                flows: { authorizationCodeGrant: true },
                scopes: [
                    cognito.OAuthScope.OPENID,
                    cognito.OAuthScope.EMAIL,
                    cognito.OAuthScope.PROFILE,
                ],
                callbackUrls,
            },
            preventUserExistenceErrors: true,
            enableTokenRevocation: true,
            accessTokenValidity: cdk.Duration.hours(1),
            idTokenValidity: cdk.Duration.hours(1),
            refreshTokenValidity: cdk.Duration.days(30),
            supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
        });

        if (managedLogin === 'modern') {
            // The newer managed-login UI requires an explicit branding
            // resource per app client. `useCognitoProvidedValues: true`
            // applies Cognito's stock default styling (modern layout,
            // no custom logo or colors). Without this, Cognito returns
            // 'Login pages unavailable'.
            new cognito.CfnManagedLoginBranding(this, 'HumanClientBranding', {
                userPoolId: this.userPool.userPoolId,
                clientId: this.humanClient.userPoolClientId,
                useCognitoProvidedValues: true,
            });
        }

        const region = cdk.Stack.of(this).region;
        this.issuerUrl = `https://cognito-idp.${region}.amazonaws.com/${this.userPool.userPoolId}`;
        this.hostedUiUrl = `https://${props.domainPrefix}.auth.${region}.amazoncognito.com`;
        this.jwtAuthorizer = {
            discoveryUrl: `${this.issuerUrl}/.well-known/openid-configuration`,
            issuerUrl: this.issuerUrl,
            allowedClients: [this.humanClient.userPoolClientId],
        };

        if (!mfaRequired) {
            NagSuppressions.addResourceSuppressions(this.userPool, [
                {
                    id: 'AwsSolutions-COG2',
                    reason:
                        'MFA was explicitly relaxed via mfaRequired: false. ' +
                        'This is intended for first-run demos only — every ' +
                        'production deployment should leave the default mfaRequired: true.',
                },
            ]);
        }
        NagSuppressions.addResourceSuppressions(this.userPool, [
            {
                id: 'AwsSolutions-COG8',
                reason:
                    'Cognito Plus tier is a paid feature. Production deployments ' +
                    'should opt in by enabling advanced security at the Plus tier.',
            },
        ]);
    }
}
