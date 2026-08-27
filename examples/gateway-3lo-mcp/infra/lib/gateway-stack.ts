import * as cdk from 'aws-cdk-lib';
import { aws_bedrockagentcore as agentcore } from 'aws-cdk-lib';
import {
    AgentCoreGateway,
    OAuthCompleteSessionApi,
    type IdentityProvider,
} from '@mcp-savvy/cdk';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { GITHUB_OPENAPI_SPEC_JSON } from './openapi-github.js';

/** Inputs for the gateway-3lo-mcp gateway stack. */
export interface GatewayStackProps extends cdk.StackProps {
    /**
     * Identity provider gating the gateway AND the
     * OAuthCompleteSessionApi. Pass either a built provider or a
     * factory invoked inside the stack scope.
     */
    readonly identityProvider:
    | IdentityProvider
    | ((scope: Construct) => IdentityProvider);
    /** Override the gateway name. Defaults to `mcp-savvy-3lo-demo`. */
    readonly gatewayName?: string;
    /**
     * Override the OAuth target name. Tools surface as
     * `${targetName}_${operationId}` (e.g. `github_getAuthenticatedUser`).
     * Defaults to `github`.
     */
    readonly targetName?: string;
    /**
     * ARN of an existing AgentCore Identity OAuth2 credential provider
     * for GitHub. We deliberately do not provision the provider in
     * this example — credential providers carry IdP-side client
     * secrets, are typically shared across multiple gateways, and
     * have an entire UX of their own. Configure once via the AWS
     * console or CLI, then point every example at it.
     */
    readonly githubCredentialProviderArn: string;
    /**
     * Optional override for the GitHub OAuth scopes the gateway
     * requests. Defaults to `['repo', 'read:user']` — enough to
     * call the two demo operations.
     */
    readonly githubScopes?: string[];
}

/**
 * AgentCore Gateway demo for the 3LO (third-party OAuth) flow.
 *
 * Wires `AgentCoreGateway` against a single OpenAPI target backed
 * by GitHub's REST API, plus an `OAuthCompleteSessionApi` for the
 * second-leg session-binding callback. The bridge orchestration
 * lives in `@mcp-savvy/bridge`'s `gatewaySessionInterceptor`,
 * activated client-side when `MCP_SAVVY_COMPLETE_SESSION_URL` is
 * set.
 *
 * End-user flow:
 *   1. `make example-gateway-3lo-login` — first-leg PKCE against
 *      the gateway's IdP (Cognito / Entra / Okta).
 *   2. Agent calls a `github_*` tool → AgentCore Identity returns
 *      `-32042 UrlElicitationRequired` with a GitHub authorization
 *      URL.
 *   3. Bridge interceptor opens the browser; user grants GitHub
 *      access; AgentCore redirects to `localhost:33424/oauth2/callback`
 *      with `session_id`.
 *   4. Bridge POSTs `{ sessionUri }` with its authenticated bearer token
 *      to this stack's
 *      `OAuthCompleteSessionApi`; Lambda authorizer validates the
 *      JWT; complete-session Lambda calls `CompleteResourceTokenAuth`.
 *   5. Bridge replays the original tool call. Host sees a normal
 *      successful response.
 */
export class GatewayStack extends cdk.Stack {
    public readonly gateway: AgentCoreGateway;
    public readonly completeSession: OAuthCompleteSessionApi;

    constructor(scope: Construct, id: string, props: GatewayStackProps) {
        super(scope, id, props);

        // Acknowledge the L2's wildcard-secret-grant warning before
        // any constructs are created so it applies stack-wide. The
        // L2 emits this when the OAuth2 client-secret ARN is a token,
        // and falls back to the documented `bedrock-agentcore-identity!*`
        // pattern — exactly what we want.
        cdk.Annotations.of(this).acknowledgeWarning(
            'aws-cdk-lib.aws-bedrockagentcore:wildcardSecretArnGrant',
        );

        const targetName = props.targetName ?? 'github';
        const identityProvider =
            typeof props.identityProvider === 'function'
                ? props.identityProvider(this)
                : props.identityProvider;

        this.gateway = new AgentCoreGateway(this, 'Gateway', {
            identityProvider,
            gatewayName: props.gatewayName ?? 'mcp-savvy-3lo-demo',
            description:
                'mcp-savvy gateway-3lo-mcp demo: GitHub OpenAPI target with 3LO OAuth.',
            // 3LO targets require MCP protocol >= 2025-11-25; the
            // service rejects target creation otherwise. The L2's
            // `MCPProtocolVersion` class doesn't include the November
            // 2025 spec yet, so we synthesize it via `.of(...)`.
            protocolConfiguration: new agentcore.McpProtocolConfiguration({
                supportedVersions: [agentcore.MCPProtocolVersion.of('2025-11-25')],
                searchType: agentcore.McpGatewaySearchType.SEMANTIC,
            }),
        });

        const target = this.gateway.addOpenApiTarget('GithubTarget', {
            gatewayTargetName: targetName,
            description:
                'GitHub REST API subset (getAuthenticatedUser, listUserRepos) — ' +
                'auth via the workspace-shared GithubOauth2 credential provider.',
            apiSchema: agentcore.ApiSchema.fromInline(GITHUB_OPENAPI_SPEC_JSON),
            credentialProviderConfigurations: [
                new agentcore.OAuthCredentialProviderConfiguration({
                    providerArn: props.githubCredentialProviderArn,
                    scopes: props.githubScopes ?? ['repo', 'read:user'],
                    // The L2 grants Secrets Manager access to the
                    // gateway role for the OAuth2 client secret. When
                    // the secret ARN isn't a CDK Token at synth time,
                    // the L2 expects a literal — passing `undefined`
                    // makes the IAM policy size estimator crash. The
                    // AgentCore-managed secret follows the
                    // `bedrock-agentcore-identity!*` naming pattern,
                    // so we scope the grant to that wildcard.
                    secretArn: cdk.Arn.format(
                        {
                            service: 'secretsmanager',
                            resource: 'secret',
                            resourceName: 'bedrock-agentcore-identity!*',
                            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
                        },
                        cdk.Stack.of(this),
                    ),
                }),
            ],
        });

        // The L2 `OAuthCredentialProviderConfiguration` defaults the
        // grant type to `CLIENT_CREDENTIALS` (2LO machine-to-machine)
        // and doesn't expose the `grantType` / `defaultReturnUrl`
        // fields that the 3LO flow needs. Override at the CFN layer:
        //  - `grantType: AUTHORIZATION_CODE` flips the gateway from
        //    "call GitHub with my own client secret" to "ask the user
        //    to authorize this gateway against their GitHub account."
        //  - `defaultReturnUrl` is the AgentCore-issued URL the
        //    gateway sends users to after GitHub redirects back; for
        //    a 3LO target this MUST match a `defaultReturnUrl`
        //    registered on the workload identity (which our
        //    `OAuthCompleteSessionApi` registers automatically via
        //    `UpdateWorkloadIdentity`). The bridge then receives the
        //    final `session_id` redirect on its own loopback port.
        const cfnTarget = target.node.defaultChild as agentcore.CfnGatewayTarget;
        cfnTarget.addPropertyOverride(
            'CredentialProviderConfigurations.0.CredentialProvider.OauthCredentialProvider.GrantType',
            'AUTHORIZATION_CODE',
        );
        cfnTarget.addPropertyOverride(
            'CredentialProviderConfigurations.0.CredentialProvider.OauthCredentialProvider.DefaultReturnUrl',
            'http://localhost:33424/oauth2/callback',
        );

        this.completeSession = new OAuthCompleteSessionApi(this, 'OAuthComplete', {
            identityProvider,
            // The gateway L2 names its workload identity
            // `<gatewayName>-<runtime-suffix>`. The construct looks
            // up the resolved name via GetGateway at deploy time.
            gatewayId: this.gateway.gatewayId,
        });

        new cdk.CfnOutput(this, 'GatewayId', {
            value: this.gateway.gatewayId,
            description: 'AgentCore Gateway ID',
        });
        new cdk.CfnOutput(this, 'GatewayUrl', {
            value: this.gateway.gatewayUrl ?? '<resolved-at-deploy-time>',
            description: 'AgentCore Gateway URL — set as MCP_SAVVY_REMOTE_URL',
        });
        new cdk.CfnOutput(this, 'GatewayRegion', {
            value: this.region,
            description: 'AWS region where the gateway is deployed',
        });
        new cdk.CfnOutput(this, 'TargetName', {
            value: targetName,
            description:
                'OpenAPI target prefix — operations surface as ${targetName}_${operationId}',
        });
        new cdk.CfnOutput(this, 'CompleteSessionUrl', {
            value: this.completeSession.completeSessionUrl,
            description:
                'OAuth complete-session endpoint — set as MCP_SAVVY_COMPLETE_SESSION_URL',
        });

        cdk.Tags.of(this).add('Project', 'mcp-savvy-3lo-demo');

        // The L2's `OAuthCredentialProviderConfiguration` grants the
        // gateway role two wildcard permissions: one on the workload
        // identity ARN (`workload-identity/<gatewayName>-*`, the L2's
        // own naming pattern that lets the role serve every version of
        // the gateway), and one on the Secrets Manager `bedrock-agentcore-identity!*`
        // pattern (the L2's documented fallback when no literal secret
        // ARN is supplied). Both are emitted by the L2 by design.
        NagSuppressions.addResourceSuppressions(
            this.gateway,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason:
                        'Wildcards emitted by the L2 OAuthCredentialProviderConfiguration: ' +
                        'workload-identity ARN scoped to the gateway name (`<gatewayName>-*`), ' +
                        'and the AgentCore-managed secret pattern (`bedrock-agentcore-identity!*`). ' +
                        'Both are the L2\'s own pattern.',
                },
            ],
            true,
        );
    }
}
