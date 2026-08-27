/**
 * `AgentCoreRuntime` — opinionated subclass of the L2
 * `agentcore.Runtime` (CDK 2.257+) that consumes an `IdentityProvider`
 * directly so the example stacks stay thin.
 *
 * Subclassing (rather than wrapping) keeps the CloudFormation logical
 * IDs identical to a hand-written `new agentcore.Runtime(...)` — every
 * existing deployment is upgrade-safe.
 *
 * Defaults: MCP protocol, X-Ray tracing on, CloudWatch logs auto-wired
 * by the underlying L2. The construct also applies the cdk-nag IAM5
 * suppression for the runtime's auto-generated execution role
 * (wildcards are scoped to AgentCore-owned ARN ranges).
 */

import { aws_bedrockagentcore as agentcore } from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import {
    assertJwtAuthorizerBinding,
    type IdentityProvider,
    type JwtAuthorizerSpec,
} from './identity/identityProvider.js';

/** Configuration for an opinionated `agentcore.Runtime`. */
export interface AgentCoreRuntimeProps {
    /**
     * Identity provider whose JWT authorizer spec gates the runtime.
     * `CognitoIdentityProvider` short-circuits to the L2's
     * `usingCognito(...)` factory; `ExternalOidcIdentityProvider`
     * falls through to `usingJWT(...)` and translates an optional
     * `customClaim` into a `RuntimeCustomClaim.withStringValue(...)`
     * for IdPs whose access tokens carry the authorizing client ID
     * outside `client_id` (Entra v2.0 → `azp`, Okta → `cid`).
     */
    readonly identityProvider: IdentityProvider;
    /**
     * The Docker / ECR / S3 artifact the runtime executes. Use
     * `agentcore.AgentRuntimeArtifact.fromAsset(<dir>)` for the
     * common "Dockerfile next to your agent code" case.
     */
    readonly agentRuntimeArtifact: agentcore.AgentRuntimeArtifact;
    /**
     * Override the AgentCore runtime name. The name is the L2's
     * resource-physical-name and must match `^[a-zA-Z][a-zA-Z0-9_]{0,47}$`.
     * @default - the L2 auto-generates one.
     */
    readonly runtimeName?: string;
    /** Description surfaced by `DescribeAgentRuntime`. 1-1200 chars. */
    readonly description?: string;
    /**
     * Whether to enable X-Ray tracing.
     * @default true
     */
    readonly tracingEnabled?: boolean;
    /**
     * Protocol the runtime speaks. Defaults to MCP since that is the
     * whole point of `mcp-savvy`.
     * @default agentcore.ProtocolType.MCP
     */
    readonly protocolConfiguration?: agentcore.ProtocolType;
    /**
     * Logging destinations (CloudWatch Logs, S3, Firehose). Defaults
     * to whatever the L2 wires up automatically (CloudWatch Logs).
     */
    readonly loggingConfigs?: agentcore.LoggingConfig[];
    /**
     * Environment variables passed to the runtime container. Mirrors
     * the L2's `environmentVariables` prop. Up to 50 entries; keys
     * 1-100 chars (letter/underscore-prefixed), values 0-2048 chars.
     */
    readonly environmentVariables?: { readonly [key: string]: string };
}

/**
 * Opinionated AgentCore Runtime gated by an `IdentityProvider`.
 *
 * The construct is intentionally thin — it owns the authorizer
 * translation and the cdk-nag IAM5 suppression so every example
 * stack doesn't repeat the same boilerplate. Cross-stack outputs
 * (ARN / ID / region) are the responsibility of the caller because
 * they're stack concerns, not construct concerns.
 *
 * Inherits all attributes (`agentRuntimeArn`, `agentRuntimeId`,
 * `agentRuntimeName`, `role`, …) and methods (`addEndpoint(...)`)
 * from the L2 base class.
 */
export class AgentCoreRuntime extends agentcore.Runtime {
    constructor(scope: Construct, id: string, props: AgentCoreRuntimeProps) {
        const tracingEnabled = props.tracingEnabled ?? true;
        const protocolConfiguration =
            props.protocolConfiguration ?? agentcore.ProtocolType.MCP;

        const runtimeProps: agentcore.RuntimeProps = {
            agentRuntimeArtifact: props.agentRuntimeArtifact,
            protocolConfiguration,
            authorizerConfiguration: buildAuthorizer(props.identityProvider),
            tracingEnabled,
            ...(props.runtimeName !== undefined ? { runtimeName: props.runtimeName } : {}),
            ...(props.description !== undefined ? { description: props.description } : {}),
            ...(props.loggingConfigs !== undefined
                ? { loggingConfigs: props.loggingConfigs }
                : {}),
            ...(props.environmentVariables !== undefined
                ? { environmentVariables: { ...props.environmentVariables } }
                : {}),
        };

        super(scope, id, runtimeProps);

        // The L2 Runtime construct auto-generates an execution role with
        // wildcards on AgentCore-required actions: CloudWatch Logs (creating
        // log groups for the runtime), X-Ray, and the workload-identity
        // directory. These are scoped to AgentCore-owned ARN ranges and
        // are required by the service. cdk-nag's IAM5 rule expects an
        // explicit suppression with evidence — that's this block.
        NagSuppressions.addResourceSuppressions(
            this,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason:
                        'AgentCore Runtime auto-managed execution role. Wildcards are ' +
                        'scoped to AgentCore-owned ARN ranges (logs:/aws/bedrock-agentcore/* ' +
                        'and bedrock-agentcore:workload-identity-directory/default/*). ' +
                        'See https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html',
                },
            ],
            true,
        );
    }
}

/** Translate an `IdentityProvider` into the L2 authorizer config. */
function buildAuthorizer(
    idp: IdentityProvider,
): agentcore.RuntimeAuthorizerConfiguration {
    const spec: JwtAuthorizerSpec = idp.jwtAuthorizer;
    assertJwtAuthorizerBinding(spec);
    const customClaims = spec.customClaim !== undefined
        ? [
            agentcore.RuntimeCustomClaim.withStringValue(
                spec.customClaim.name,
                spec.customClaim.value,
            ),
        ]
        : undefined;

    if (idp.kind === 'cognito') {
        return agentcore.RuntimeAuthorizerConfiguration.usingCognito(
            idp.userPool,
            [idp.humanClient],
            spec.allowedAudience,
            spec.allowedScopes,
            customClaims,
        );
    }
    return agentcore.RuntimeAuthorizerConfiguration.usingJWT(
        spec.discoveryUrl,
        spec.allowedClients,
        spec.allowedAudience,
        spec.allowedScopes,
        customClaims,
    );
}
