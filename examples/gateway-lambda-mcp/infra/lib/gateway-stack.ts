import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { aws_bedrockagentcore as agentcore } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { AgentCoreGateway, type IdentityProvider } from '@mcp-savvy/cdk';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.resolve(HERE, '..', '..', 'tools');

/** Inputs for the gateway stack. */
export interface GatewayStackProps extends cdk.StackProps {
    /**
     * Identity provider (Cognito or external OIDC) gating the gateway.
     * Pass either a pre-built provider, or a factory that's invoked
     * inside the stack so its constructs (e.g. imported user pools)
     * live in the right scope.
     */
    readonly identityProvider:
    | IdentityProvider
    | ((scope: Construct) => IdentityProvider);
    /** Override the gateway name. Defaults to `mcp-savvy-gw-demo`. */
    readonly gatewayName?: string;
    /**
     * Override the target name. The gateway exposes tools as
     * `${targetName}_${toolName}`, e.g. `tools_getCurrentTime`.
     * Defaults to `tools`.
     */
    readonly targetName?: string;
}

/**
 * AgentCore Gateway for the mcp-savvy gateway-lambda-mcp demo.
 *
 * Wires `@mcp-savvy/cdk`'s `AgentCoreGateway` construct against a
 * single Lambda target that implements two trivial tools. The
 * `getCurrentTime` and `summarizeText` tools share one Lambda so
 * the example stays small — production deployments often split
 * tools into multiple Lambdas + targets.
 */
export class GatewayStack extends cdk.Stack {
    public readonly gateway: AgentCoreGateway;
    public readonly toolsFn: lambda.Function;

    constructor(scope: Construct, id: string, props: GatewayStackProps) {
        super(scope, id, props);

        const targetName = props.targetName ?? 'tools';
        const identityProvider =
            typeof props.identityProvider === 'function'
                ? props.identityProvider(this)
                : props.identityProvider;

        // Lambda backing the gateway target. The handler dispatches on
        // `context.bedrockAgentCoreToolName` after stripping the target
        // prefix; see `tools/handler.mjs` for the full contract.
        const toolsLogGroup = new logs.LogGroup(this, 'ToolsFnLogs', {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        this.toolsFn = new lambda.Function(this, 'ToolsFn', {
            runtime: lambda.Runtime.NODEJS_22_X,
            architecture: lambda.Architecture.ARM_64,
            handler: 'handler.handler',
            code: lambda.Code.fromAsset(TOOLS_DIR),
            timeout: cdk.Duration.seconds(10),
            memorySize: 256,
            environment: {
                GATEWAY_TARGET_NAME: targetName,
            },
            logGroup: toolsLogGroup,
            description:
                'mcp-savvy gateway-lambda-mcp demo: implements getCurrentTime + summarizeText tools.',
        });

        this.gateway = new AgentCoreGateway(this, 'Gateway', {
            identityProvider,
            gatewayName: props.gatewayName ?? 'mcp-savvy-gw-demo',
            description:
                'mcp-savvy gateway-lambda-mcp demo: exposes Lambda-backed tools over MCP.',
        });

        // Register the Lambda as an MCP target. Tool names are exposed
        // on the wire as `${targetName}_${toolName}`, so the smoke test
        // calls e.g. `tools_getCurrentTime`.
        this.gateway.addLambdaTarget('ToolsTarget', {
            gatewayTargetName: targetName,
            description: 'Lambda-backed tools (getCurrentTime, summarizeText).',
            lambdaFunction: this.toolsFn,
            toolSchema: agentcore.ToolSchema.fromInline([
                {
                    name: 'getCurrentTime',
                    description:
                        'Return the current time. Pass an IANA timezone (e.g. "America/Los_Angeles") to format it; defaults to UTC. Falls back to UTC for unknown zones.',
                    inputSchema: {
                        type: agentcore.SchemaDefinitionType.OBJECT,
                        properties: {
                            timezone: {
                                type: agentcore.SchemaDefinitionType.STRING,
                                description:
                                    'IANA timezone name (e.g. "America/Los_Angeles"). Optional; defaults to UTC.',
                            },
                        },
                    },
                },
                {
                    name: 'summarizeText',
                    description:
                        'Return a deterministic mock summary of an input string. Truncates to maxChars and reports the source word count. No model is invoked.',
                    inputSchema: {
                        type: agentcore.SchemaDefinitionType.OBJECT,
                        properties: {
                            text: {
                                type: agentcore.SchemaDefinitionType.STRING,
                                description: 'Text to summarize.',
                            },
                            maxChars: {
                                type: agentcore.SchemaDefinitionType.INTEGER,
                                description:
                                    'Maximum length of the returned summary. Optional; defaults to 80.',
                            },
                        },
                        required: ['text'],
                    },
                },
            ]),
        });

        new cdk.CfnOutput(this, 'GatewayId', {
            value: this.gateway.gatewayId,
            description: 'AgentCore Gateway ID',
        });
        new cdk.CfnOutput(this, 'GatewayUrl', {
            value: this.gateway.gatewayUrl ?? '<resolved-at-deploy-time>',
            description:
                'AgentCore Gateway URL — set as MCP_SAVVY_REMOTE_URL',
        });
        new cdk.CfnOutput(this, 'GatewayRegion', {
            value: this.region,
            description: 'AWS region where the gateway is deployed',
        });
        new cdk.CfnOutput(this, 'TargetName', {
            value: targetName,
            description:
                'Gateway target prefix — tools appear as ${targetName}_${toolName} on the wire',
        });

        cdk.Tags.of(this).add('Project', 'mcp-savvy-gateway-demo');

        // cdk-nag's AwsSolutions-L1 flags Lambda functions not on the
        // "latest" runtime per its own internal map, which lags
        // shortly after AWS releases a new Node version. NODEJS_22_X
        // is the current AWS-supported latest at the time of writing.
        NagSuppressions.addResourceSuppressions(
            this.toolsFn,
            [
                {
                    id: 'AwsSolutions-L1',
                    reason:
                        'NODEJS_22_X is the current AWS-supported latest Node Lambda ' +
                        'runtime; cdk-nag\'s internal "latest" map lags releases. ' +
                        'Re-evaluate on cdk-nag upgrades.',
                },
                {
                    id: 'AwsSolutions-IAM4',
                    reason:
                        'L2 Lambda execution role uses AWSLambdaBasicExecutionRole, ' +
                        'the AWS-managed policy that grants only CloudWatch Logs ' +
                        'write permissions for the function\'s own log group. This ' +
                        'is the standard L2 default and the minimum a Lambda needs.',
                    appliesTo: [
                        'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
                    ],
                },
            ],
            true,
        );
        // The gateway service role gets a trust policy with conditional
        // wildcards on `aws:SourceArn` (gatewayName + version suffix).
        // This is the L2's own pattern; cdk-nag still flags it.
        NagSuppressions.addResourceSuppressions(
            this.gateway,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason:
                        'AgentCore Gateway auto-managed service role. The wildcard on ' +
                        'aws:SourceArn (`gateway/<name>*`) lets the same role serve ' +
                        'every version of the same gateway, which is what the L2 ' +
                        'construct emits by design.',
                },
            ],
            true,
        );
    }
}
