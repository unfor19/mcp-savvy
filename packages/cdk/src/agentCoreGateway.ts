/**
 * `AgentCoreGateway` — opinionated subclass of the L2
 * `agentcore.Gateway` (CDK 2.257+) that consumes an `IdentityProvider`
 * directly so the example stacks stay thin.
 *
 * Mirrors `AgentCoreRuntime`'s shape: the construct extends the L2
 * (rather than wrapping it) so the synthesized CloudFormation logical
 * IDs are unchanged from a hand-written `new agentcore.Gateway(...)`.
 *
 * Target factories — `addLambdaTarget(...)`, `addOpenApiTarget(...)`,
 * `addSmithyTarget(...)`, `addMcpServerTarget(...)`,
 * `addApiGatewayTarget(...)` — are inherited from the L2 unchanged.
 */

import { Stack, aws_bedrockagentcore as agentcore, aws_iam as iam } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
    assertJwtAuthorizerBinding,
    type IdentityProvider,
    type JwtAuthorizerSpec,
} from './identity/identityProvider.js';

/** Configuration for an opinionated `agentcore.Gateway`. */
export interface AgentCoreGatewayProps {
    /**
     * Identity provider whose JWT authorizer spec gates the gateway.
     * `CognitoIdentityProvider` short-circuits to the L2's
     * `GatewayAuthorizer.usingCognito(...)` factory; an
     * `ExternalOidcIdentityProvider` falls through to
     * `GatewayAuthorizer.usingCustomJwt(...)` and translates an
     * optional `customClaim` into a `GatewayCustomClaim.withStringValue(...)`
     * for IdPs whose access tokens carry the authorizing client ID
     * outside `client_id` (Entra v2.0 → `azp`, Okta → `cid`).
     */
    readonly identityProvider: IdentityProvider;
    /**
     * Override the gateway name. Must match `^([0-9a-zA-Z][-]?){1,48}$`.
     * @default - the L2 auto-generates one.
     */
    readonly gatewayName?: string;
    /** Description surfaced by `GetGateway`. Up to 200 chars. */
    readonly description?: string;
    /**
     * Protocol configuration — defaults to MCP with the L2's stock
     * defaults (semantic search, recommended supported versions).
     * Override if you need a non-default instructions string or
     * to pin a specific MCP protocol version.
     * @default - the L2's default MCP configuration
     */
    readonly protocolConfiguration?: agentcore.IGatewayProtocolConfig;
    /**
     * Verbosity of exception messages. Use `DEBUG` for development
     * gateways; the default sanitizes for end users.
     */
    readonly exceptionLevel?: agentcore.GatewayExceptionLevel;
}

/**
 * Opinionated AgentCore Gateway gated by an `IdentityProvider`.
 *
 * The construct is intentionally thin — it owns the authorizer
 * translation (Cognito short-circuit vs custom JWT with optional
 * azp custom-claim) so example stacks don't repeat the same
 * boilerplate. Users add MCP targets via the inherited
 * `addLambdaTarget` / `addOpenApiTarget` / `addSmithyTarget` /
 * `addMcpServerTarget` / `addApiGatewayTarget` methods.
 */
export class AgentCoreGateway extends agentcore.Gateway {
    constructor(scope: Construct, id: string, props: AgentCoreGatewayProps) {
        const gatewayProps: agentcore.GatewayProps = {
            authorizerConfiguration: buildAuthorizer(props.identityProvider),
            ...(props.gatewayName !== undefined ? { gatewayName: props.gatewayName } : {}),
            ...(props.description !== undefined ? { description: props.description } : {}),
            ...(props.protocolConfiguration !== undefined
                ? { protocolConfiguration: props.protocolConfiguration }
                : {}),
            ...(props.exceptionLevel !== undefined
                ? { exceptionLevel: props.exceptionLevel }
                : {}),
        };

        super(scope, id, gatewayProps);

        // CDK 2.257 emits an unconditional AgentCore trust statement alongside
        // its protected one. Override only the trust document until the L2
        // removes that confused-deputy path.
        const role = this.role.node.defaultChild as iam.CfnRole;
        const stack = Stack.of(this);
        role.addPropertyOverride('AssumeRolePolicyDocument', {
            Version: '2012-10-17',
            Statement: [{
                Effect: 'Allow',
                Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
                Action: 'sts:AssumeRole',
                Condition: {
                    StringEquals: { 'aws:SourceAccount': stack.account },
                    ArnLike: {
                        'aws:SourceArn': stack.formatArn({
                            service: 'bedrock-agentcore',
                            resource: 'gateway',
                            resourceName: `${this.gatewayName}*`,
                        }),
                    },
                },
            }],
        });
    }
}

/** Translate an `IdentityProvider` into the L2 authorizer config. */
function buildAuthorizer(idp: IdentityProvider): agentcore.IGatewayAuthorizerConfig {
    const spec: JwtAuthorizerSpec = idp.jwtAuthorizer;
    assertJwtAuthorizerBinding(spec);
    const customClaims = spec.customClaim !== undefined
        ? [
            agentcore.GatewayCustomClaim.withStringValue(
                spec.customClaim.name,
                spec.customClaim.value,
            ),
        ]
        : undefined;

    if (idp.kind === 'cognito') {
        return agentcore.GatewayAuthorizer.usingCognito({
            userPool: idp.userPool,
            allowedClients: [idp.humanClient],
            ...(spec.allowedAudience !== undefined
                ? { allowedAudiences: spec.allowedAudience }
                : {}),
            ...(spec.allowedScopes !== undefined ? { allowedScopes: spec.allowedScopes } : {}),
            ...(customClaims !== undefined ? { customClaims } : {}),
        });
    }
    return agentcore.GatewayAuthorizer.usingCustomJwt({
        discoveryUrl: spec.discoveryUrl,
        ...(spec.allowedAudience !== undefined ? { allowedAudience: spec.allowedAudience } : {}),
        ...(spec.allowedClients !== undefined ? { allowedClients: spec.allowedClients } : {}),
        ...(spec.allowedScopes !== undefined ? { allowedScopes: spec.allowedScopes } : {}),
        ...(customClaims !== undefined ? { customClaims } : {}),
    });
}
