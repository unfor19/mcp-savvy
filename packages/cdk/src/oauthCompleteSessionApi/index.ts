/**
 * `OAuthCompleteSessionApi` — REST API + Lambda authorizer + Lambda
 * that completes AgentCore Identity 3LO sessions on behalf of the
 * `mcp-savvy` bridge.
 *
 * Deploys alongside an `AgentCoreGateway` (or anything else with a
 * workload-identity name). Bridge flow:
 *   1. User calls a 3LO-gated tool. Gateway responds with an
 *      authorization URL.
 *   2. Browser → third-party IdP (GitHub etc.) → AgentCore Identity
 *      callback → bridge's local-loopback callback (with `session_id`
 *      query param). The loopback URL must be pre-registered as
 *      `AllowedResourceOAuth2ReturnUrl` on the gateway's workload
 *      identity — this construct does that registration via an
 *      `UpdateWorkloadIdentity` custom resource.
 *   3. Bridge POSTs `{ sessionUri }` with its authenticated bearer token
 *      to this construct's
 *      API URL (Bearer JWT). Lambda authorizer validates the JWT;
 *      complete-session Lambda calls `CompleteResourceTokenAuth`.
 *
 * See SECURITY.md for the full design rationale (REST API +
 * Lambda authorizer chosen over HTTP API + native JWT authorizer
 * for IdP-uniformity).
 */

import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import {
    assertJwtAuthorizerBinding,
    type IdentityProvider,
} from '../identity/identityProvider.js';
import { buildAuthorizerLambda, buildCompleteSessionLambda } from './lambdas.js';
import { applyOAuthCompleteSessionNagSuppressions } from './nag.js';
import { DEFAULT_LOOPBACK_URLS, registerLoopbackUrls } from './workloadIdentity.js';

/** Configuration for `OAuthCompleteSessionApi`. */
export interface OAuthCompleteSessionApiProps {
    /**
     * Identity provider whose JWT gates the gateway. The same JWT
     * gates this API — no extra credentials on the client.
     */
    readonly identityProvider: IdentityProvider;
    /**
     * Gateway whose workload-identity should accept the bridge's
     * loopback URLs as `AllowedResourceOAuth2ReturnUrl`. Pass the
     * `gatewayId` of the gateway you want to gate with this 3LO
     * completion API. The construct looks up the workload-identity
     * ARN at deploy time via `GetGateway` (the L2 gateway appends a
     * runtime-resolved suffix to the workload-identity name, so we
     * can't compute it from the gateway name at synth time).
     */
    readonly gatewayId: string;
    /**
     * Bridge loopback callback URLs to register as
     * `AllowedResourceOAuth2ReturnUrl` on the workload identity.
     * @default the four standard mcp-savvy loopback URLs (localhost
     *          + 127.0.0.1 on ports 33424 and 33419).
     */
    readonly loopbackCallbackUrls?: readonly string[];
    /**
     * REST API throttling. Defaults to 100 req/s steady, 200 burst.
     * The endpoint fires once per OAuth flow per user, so this is
     * generous for any realistic deployment.
     */
    readonly throttling?: { readonly rateLimit: number; readonly burstLimit: number };
}

/**
 * REST API + Lambda authorizer + complete-session Lambda + workload
 * identity custom resource. Exposes `completeSessionUrl` as the
 * value users put in `MCP_SAVVY_COMPLETE_SESSION_URL`.
 *
 * IdP-agnostic: the Lambda authorizer validates any OIDC JWT
 * (Cognito, Entra v1+v2, Okta, Auth0, Keycloak) — that's why we use
 * a Lambda authorizer rather than the native API Gateway JWT
 * authorizer (which is Cognito-only).
 */
export class OAuthCompleteSessionApi extends Construct {
    /** The deployed REST API. Useful when composing with `ApiGatewayFrontDoor`. */
    public readonly api: apigateway.RestApi;
    /** The complete-session Lambda. Exposed for log-group ergonomics. */
    public readonly completeSessionFn: lambda.Function;
    /** The OIDC Lambda authorizer. */
    public readonly authorizerFn: lambda.Function;
    /**
     * The full POST URL the bridge writes to. Set this as
     * `MCP_SAVVY_COMPLETE_SESSION_URL` on the bridge.
     */
    public readonly completeSessionUrl: string;

    constructor(scope: Construct, id: string, props: OAuthCompleteSessionApiProps) {
        super(scope, id);

        const loopbackUrls = props.loopbackCallbackUrls ?? DEFAULT_LOOPBACK_URLS;
        const throttling = props.throttling ?? { rateLimit: 100, burstLimit: 200 };
        const spec = props.identityProvider.jwtAuthorizer;
        assertJwtAuthorizerBinding(spec);

        this.authorizerFn = buildAuthorizerLambda(this, spec);
        this.completeSessionFn = buildCompleteSessionLambda(this);

        this.api = new apigateway.RestApi(this, 'Api', {
            restApiName: cdk.Names.uniqueResourceName(this, { maxLength: 40 }),
            description: 'mcp-savvy OAuth 3LO completion API (JWT-protected).',
            deployOptions: {
                stageName: 'v1',
                throttlingRateLimit: throttling.rateLimit,
                throttlingBurstLimit: throttling.burstLimit,
                tracingEnabled: true,
                metricsEnabled: true,
            },
            defaultCorsPreflightOptions: {
                allowOrigins: apigateway.Cors.ALL_ORIGINS,
                allowMethods: ['POST', 'OPTIONS'],
                allowHeaders: ['Content-Type', 'Authorization'],
            },
            cloudWatchRole: true,
        });

        const tokenAuthorizer = new apigateway.TokenAuthorizer(this, 'JwtAuthorizer', {
            handler: this.authorizerFn,
            identitySource: apigateway.IdentitySource.header('Authorization'),
            resultsCacheTtl: cdk.Duration.minutes(5),
        });

        const completeSession = this.api.root.addResource('complete-session');
        completeSession.addMethod(
            'POST',
            new apigateway.LambdaIntegration(this.completeSessionFn, { proxy: true }),
            {
                authorizer: tokenAuthorizer,
                authorizationType: apigateway.AuthorizationType.CUSTOM,
            },
        );

        this.completeSessionUrl = `${this.api.url}complete-session`;

        registerLoopbackUrls(this, props.gatewayId, loopbackUrls);
        applyOAuthCompleteSessionNagSuppressions(this);
    }
}
