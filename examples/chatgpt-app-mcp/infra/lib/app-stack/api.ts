/**
 * Public Regional REST API for the chatgpt-app-mcp example.
 *
 * Deployment Pattern D (see DEPLOYMENT-PATTERNS.md):
 *
 *   ChatGPT
 *     │  Authorization: Bearer <Cognito access token>
 *     ▼  HTTPS to <custom domain>
 *   Public REST API Gateway (Regional)
 *     │  WAF: managed rules + rate limit + body size
 *     │  Cognito User Pool Authorizer (JWT verification + scope)
 *     │  Request Validator (JSON-RPC envelope schema)
 *     ▼  proxy integration
 *   Lambda
 *
 * The Lambda code never sees an unauthenticated request. WAF +
 * Cognito Authorizer + Request Validator together gate every
 * authenticated route before invocation. The default execute-api
 * endpoint is disabled so only the custom domain works.
 *
 * Public well-known routes (`/.well-known/oauth-protected-resource`
 * + `oauth-authorization-server` + `openid-configuration`) bypass
 * the authorizer per RFC 9728 / RFC 8414.
 */

import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/** Inputs for `wireRestApi`. */
export interface RestApiConfig {
    /** Lambda invoked by every authenticated route. */
    readonly mcpFn: lambda.IFunction;
    /** Cognito user pool the authorizer validates JWTs against. */
    readonly cognitoUserPool: cognito.IUserPool;
    /** Required scope on every authenticated route (e.g. `<resource>/balance.read`). */
    readonly requiredScope: string;
    /** Public custom domain (FQDN). The default execute-api endpoint is disabled. */
    readonly domain: string;
    /** ACM cert ARN for the custom domain. Must be in the same region as the API. */
    readonly certificateArn: string;
}

/** Outputs from `wireRestApi`. */
export interface RestApiResources {
    /** The REST API. */
    readonly api: apigateway.RestApi;
    /** The custom domain bound to the API. */
    readonly domainName: apigateway.DomainName;
}

/** Build the REST API + custom domain + authorizer + validator + integrations. */
export function wireRestApi(
    scope: Construct,
    id: string,
    config: RestApiConfig,
): RestApiResources {
    const api = buildRestApi(scope, id);
    const domainName = bindCustomDomain(scope, api, config);
    addAuthenticatedRoutes(api, config);
    addPublicRoutes(api, config);
    addOAuthDiscoveryGatewayResponses(api, config);
    applyApiNagSuppressions(api);
    return { api, domainName };
}

/** Construct the public REST API; default endpoint disabled. */
function buildRestApi(scope: Construct, id: string): apigateway.RestApi {
    const apiLogs = new cdk.aws_logs.LogGroup(scope, `${id}AccessLogs`, {
        retention: cdk.aws_logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    return new apigateway.RestApi(scope, id, {
        restApiName: 'mcp-savvy-chatgpt-app',
        description:
            'mcp-savvy chatgpt-app-mcp public REST API. Auth via Cognito User Pool ' +
            'Authorizer; request shape validated by an API Gateway model.',
        endpointConfiguration: { types: [apigateway.EndpointType.REGIONAL] },
        // Disable the default <api-id>.execute-api.<region>.amazonaws.com
        // endpoint. Only the custom domain alias resolves.
        disableExecuteApiEndpoint: true,
        deployOptions: {
            stageName: 'prod',
            tracingEnabled: true,
            metricsEnabled: true,
            loggingLevel: apigateway.MethodLoggingLevel.ERROR,
            accessLogDestination: new apigateway.LogGroupLogDestination(apiLogs),
            accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
                caller: false,
                httpMethod: true,
                ip: true,
                protocol: true,
                requestTime: true,
                resourcePath: true,
                responseLength: true,
                status: true,
                user: false,
            }),
        },
        cloudWatchRole: true,
    });
}

/** Bind a regional custom domain (TLS 1.2_2021 floor) to the API. */
function bindCustomDomain(
    scope: Construct,
    api: apigateway.RestApi,
    config: RestApiConfig,
): apigateway.DomainName {
    const certificate = acm.Certificate.fromCertificateArn(
        scope,
        'ApiCertificate',
        config.certificateArn,
    );
    return new apigateway.DomainName(scope, 'ApiDomain', {
        domainName: config.domain,
        certificate,
        endpointType: apigateway.EndpointType.REGIONAL,
        securityPolicy: apigateway.SecurityPolicy.TLS_1_2,
        mapping: api,
    });
}

/** Wire `POST /`, `POST /mcp`, `POST /widgets/balance` with auth + validation. */
function addAuthenticatedRoutes(api: apigateway.RestApi, config: RestApiConfig): void {
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(api, 'CognitoAuthorizer', {
        cognitoUserPools: [config.cognitoUserPool],
        identitySource: 'method.request.header.Authorization',
        authorizerName: 'mcp-savvy-chatgpt-app-cognito',
    });
    const validator = new apigateway.RequestValidator(api, 'JsonRpcValidator', {
        restApi: api,
        requestValidatorName: 'jsonrpc-envelope',
        validateRequestBody: true,
        validateRequestParameters: false,
    });
    const model = jsonRpcModel(api);

    const integration = new apigateway.LambdaIntegration(config.mcpFn, {
        proxy: true,
        timeout: cdk.Duration.seconds(29),
    });
    const methodOpts: apigateway.MethodOptions = {
        authorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizationScopes: [config.requiredScope],
        requestValidator: validator,
        requestModels: { 'application/json': model },
    };

    api.root.addMethod('POST', integration, methodOpts);
    api.root.addResource('mcp').addMethod('POST', integration, methodOpts);
    api.root
        .addResource('widgets')
        .addResource('balance')
        .addMethod('POST', integration, methodOpts);
}

/** JSON-RPC 2.0 envelope schema enforced before the Lambda runs. */
function jsonRpcModel(api: apigateway.RestApi): apigateway.IModel {
    return new apigateway.Model(api, 'JsonRpcEnvelope', {
        restApi: api,
        modelName: 'JsonRpcEnvelope',
        contentType: 'application/json',
        schema: {
            type: apigateway.JsonSchemaType.OBJECT,
            required: ['jsonrpc', 'method'],
            properties: {
                jsonrpc: { type: apigateway.JsonSchemaType.STRING, enum: ['2.0'] },
                method: { type: apigateway.JsonSchemaType.STRING, minLength: 1 },
                params: {},
            },
            additionalProperties: true,
        },
    });
}

/**
 * Wire the public well-known routes. RFC 9728 / RFC 8414 require
 * these to be discoverable without auth — they go through the same
 * Lambda but no authorizer applies.
 */
function addPublicRoutes(api: apigateway.RestApi, config: RestApiConfig): void {
    const integration = new apigateway.LambdaIntegration(config.mcpFn, { proxy: true });
    const wellKnown = api.root.addResource('.well-known');
    wellKnown.addResource('oauth-protected-resource').addMethod('GET', integration);
    wellKnown.addResource('oauth-authorization-server').addMethod('GET', integration);
    wellKnown.addResource('openid-configuration').addMethod('GET', integration);
}

/**
 * Override API Gateway's default 401 / 403 responses so they carry
 * a `WWW-Authenticate` header pointing at the protected-resource
 * metadata. RFC 6750 + RFC 9728: OAuth-aware clients (ChatGPT,
 * Claude, the local mcp-savvy bridge) probe a protected endpoint
 * without a token, see the 401, follow `resource_metadata` to
 * `/.well-known/oauth-protected-resource`, and discover the issuer
 * + scopes + token endpoint from there.
 *
 * Two responses get the same hint:
 *   - UNAUTHORIZED (401) — Cognito authorizer rejects an invalid token
 *   - MISSING_AUTHENTICATION_TOKEN (403) — request had no Authorization
 *     header at all (or no method matched the path)
 */
function addOAuthDiscoveryGatewayResponses(
    api: apigateway.RestApi,
    config: RestApiConfig,
): void {
    const wellKnown = `${config.domain.replace(/\/+$/, '')}/.well-known/oauth-protected-resource`;
    // VTL-style single-quote wrapping is API Gateway's literal-value
    // form for response header parameters. Inner double-quotes are
    // RFC 6750's quoted-string format for `realm` etc.
    const challenge =
        `'Bearer realm=\"mcp-savvy-chatgpt-app\", error=\"invalid_token\", ` +
        `resource_metadata=\"https://${wellKnown}\"'`;
    new apigateway.GatewayResponse(api, 'UnauthorizedResponse', {
        restApi: api,
        type: apigateway.ResponseType.UNAUTHORIZED,
        statusCode: '401',
        responseHeaders: {
            'WWW-Authenticate': challenge,
            'Access-Control-Allow-Origin': "'*'",
        },
    });
    new apigateway.GatewayResponse(api, 'MissingAuthTokenResponse', {
        restApi: api,
        type: apigateway.ResponseType.MISSING_AUTHENTICATION_TOKEN,
        // Map 403 → 401 so OAuth clients consistently see "auth required."
        // RFC 6750 section 3 specifies 401 for missing or invalid Bearer tokens.
        statusCode: '401',
        responseHeaders: {
            'WWW-Authenticate': challenge,
            'Access-Control-Allow-Origin': "'*'",
        },
    });
}

/** cdk-nag suppressions for the API Gateway. */
function applyApiNagSuppressions(api: apigateway.RestApi): void {
    NagSuppressions.addResourceSuppressions(
        api,
        [
            {
                id: 'AwsSolutions-APIG2',
                reason:
                    'Request body validation IS enabled via the JsonRpcEnvelope model + ' +
                    'RequestValidator on every authenticated method. cdk-nag flags the API ' +
                    'as a whole; the per-method validators cover the actual surface.',
            },
            {
                id: 'AwsSolutions-APIG4',
                reason:
                    'Public well-known routes (/.well-known/*) intentionally have no authorizer per ' +
                    'RFC 9728 / RFC 8414. Authenticated routes use Cognito User Pool Authorizer.',
            },
            {
                id: 'AwsSolutions-COG4',
                reason:
                    'Cognito User Pool Authorizer is configured on every authenticated route. ' +
                    'cdk-nag misses it because the well-known routes are intentionally unauthorized.',
            },
            {
                id: 'AwsSolutions-IAM4',
                reason:
                    "API Gateway's account-level CloudWatch logging role uses the AWS-managed " +
                    'AmazonAPIGatewayPushToCloudWatchLogs policy — the standard L2 default for ' +
                    '`cloudWatchRole: true`. The role is the API-Gateway-account singleton; its ' +
                    'permissions are fixed by the API Gateway service contract.',
                appliesTo: [
                    'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs',
                ],
            },
        ],
        true,
    );
}
