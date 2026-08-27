import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { aws_bedrockagentcore as agentcore } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AgentCoreGateway, type IdentityProvider } from '@mcp-savvy/cdk';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { buildKbToolSchema } from './tool-schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HANDLER = path.resolve(HERE, '..', '..', 'tools', 'handler.mjs');

/** Inputs for the gateway-kb-mcp gateway stack. */
export interface GatewayStackProps extends cdk.StackProps {
    /** Identity provider gating the gateway. */
    readonly identityProvider:
    | IdentityProvider
    | ((scope: Construct) => IdentityProvider);
    /** Bedrock KB id (from `KbStack`). */
    readonly knowledgeBaseId: string;
    /** Bedrock KB ARN (from `KbStack`). Used for IAM scoping. */
    readonly knowledgeBaseArn: string;
    /** Override the gateway name. Defaults to `mcp-savvy-gw-kb-demo`. */
    readonly gatewayName?: string;
    /** Override the target name. Tools appear as `${target}___${tool}`. Defaults to `kb`. */
    readonly targetName?: string;
    /**
     * Model id/ARN used by `kb_retrieve_and_generate`. Defaults to the
     * Sonnet 4.6 US cross-region inference profile. The Lambda role is
     * granted InvokeModel* on this profile + its destination-region
     * foundation-model ARNs.
     */
    readonly generationModelId?: string;
}

/**
 * AgentCore Gateway for the gateway-kb-mcp demo (no LLM in the loop).
 *
 * A single Lambda target forwards `kb_retrieve` and
 * `kb_retrieve_and_generate` straight to `bedrock-agent-runtime`.
 * The host LLM drives RAG; the Lambda is a thin auth-gated proxy.
 * Bundled as CJS via `NodejsFunction` so the bedrock-agent-runtime
 * client (not in the Node 22 runtime's curated SDK set) ships in
 * the zip, and to dodge the require('node:https') ESM trap.
 */
export class GatewayStack extends cdk.Stack {
    public readonly gateway: AgentCoreGateway;
    public readonly kbFn: lambda.Function;

    constructor(scope: Construct, id: string, props: GatewayStackProps) {
        super(scope, id, props);

        const targetName = props.targetName ?? 'kb';
        const identityProvider =
            typeof props.identityProvider === 'function'
                ? props.identityProvider(this)
                : props.identityProvider;

        const generationModelId =
            props.generationModelId ?? 'us.anthropic.claude-sonnet-4-6';
        const generationModelArn = cdk.Arn.format(
            {
                service: 'bedrock',
                resource: 'inference-profile',
                resourceName: generationModelId,
            },
            this,
        );

        const kbLogGroup = new logs.LogGroup(this, 'KbFnLogs', {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        this.kbFn = new NodejsFunction(this, 'KbFn', {
            runtime: lambda.Runtime.NODEJS_22_X,
            architecture: lambda.Architecture.ARM_64,
            entry: HANDLER,
            handler: 'handler',
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
            reservedConcurrentExecutions: 10,
            environment: {
                GATEWAY_TARGET_NAME: targetName,
                MCP_SAVVY_KB_ID: props.knowledgeBaseId,
                MCP_SAVVY_KB_GENERATION_MODEL_ARN: generationModelArn,
            },
            logGroup: kbLogGroup,
            bundling: {
                format: cdk.aws_lambda_nodejs.OutputFormat.CJS,
                target: 'node22',
                // The bedrock-agent-runtime client is NOT in the Node 22
                // runtime's curated SDK bundle — force it into the zip.
                bundleAwsSDK: true,
            },
            description:
                'mcp-savvy gateway-kb-mcp demo: forwards kb_retrieve(+_and_generate) to bedrock-agent-runtime.',
        });

        // KB grants — scoped to this KB ARN, plus InvokeModel* on the
        // generation profile + its US destination-region FM ARNs for
        // kb_retrieve_and_generate.
        this.kbFn.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'KbRetrieve',
                effect: iam.Effect.ALLOW,
                actions: ['bedrock:Retrieve', 'bedrock:RetrieveAndGenerate'],
                resources: [props.knowledgeBaseArn],
            }),
        );
        const fmId = generationModelId.replace(/^[a-z]+\./, '');
        this.kbFn.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'InvokeGenerationModel',
                effect: iam.Effect.ALLOW,
                actions: ['bedrock:InvokeModel'],
                resources: [
                    generationModelArn,
                    ...['us-east-1', 'us-east-2', 'us-west-2'].map((r) =>
                        cdk.Arn.format(
                            {
                                service: 'bedrock',
                                account: '',
                                region: r,
                                resource: 'foundation-model',
                                resourceName: fmId,
                            },
                            this,
                        ),
                    ),
                ],
            }),
        );
        // RetrieveAndGenerate resolves the cross-region inference profile
        // by calling GetInferenceProfile before invoking — without this
        // grant the call fails with "Not authorized to call
        // GetInferenceProfile" (caught live, 2026-05-31).
        this.kbFn.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'GetInferenceProfile',
                effect: iam.Effect.ALLOW,
                actions: ['bedrock:GetInferenceProfile'],
                resources: [generationModelArn],
            }),
        );

        this.gateway = new AgentCoreGateway(this, 'Gateway', {
            identityProvider,
            gatewayName: props.gatewayName ?? 'mcp-savvy-gw-kb-demo',
            description:
                'mcp-savvy gateway-kb-mcp demo: KB retrieval tools over MCP, no LLM in the loop.',
        });

        this.gateway.addLambdaTarget('KbTarget', {
            gatewayTargetName: targetName,
            description: 'Lambda-backed KB tools (kb_retrieve, kb_retrieve_and_generate).',
            lambdaFunction: this.kbFn,
            toolSchema: agentcore.ToolSchema.fromInline(buildKbToolSchema()),
        });

        this.emitOutputs(targetName);
        this.applyNagSuppressions();
        cdk.Tags.of(this).add('Project', 'mcp-savvy-gateway-kb-demo');
    }

    private emitOutputs(targetName: string): void {
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
            description: 'Gateway target prefix — tools appear as ${target}___${tool}',
        });
    }

    private applyNagSuppressions(): void {
        NagSuppressions.addResourceSuppressions(
            this.kbFn,
            [
                {
                    id: 'AwsSolutions-L1',
                    reason:
                        'NODEJS_22_X is the current AWS-supported latest Node Lambda ' +
                        "runtime; cdk-nag's internal \"latest\" map lags releases.",
                },
                {
                    id: 'AwsSolutions-IAM4',
                    reason:
                        'L2 Lambda execution role uses AWSLambdaBasicExecutionRole — ' +
                        'CloudWatch Logs write for the function\'s own log group only.',
                    appliesTo: [
                        'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
                    ],
                },
                {
                    id: 'AwsSolutions-IAM5',
                    reason:
                        'kb_retrieve_and_generate invokes the cross-region inference ' +
                        'profile, which requires InvokeModel on the underlying ' +
                        'foundation-model ARN in each US destination region. Scoped ' +
                        'to the specific model id, not a wildcard action.',
                    appliesTo: [
                        'Resource::arn:<AWS::Partition>:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6',
                        'Resource::arn:<AWS::Partition>:bedrock:us-east-2::foundation-model/anthropic.claude-sonnet-4-6',
                        'Resource::arn:<AWS::Partition>:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-6',
                    ],
                },
            ],
            true,
        );
        NagSuppressions.addResourceSuppressions(
            this.gateway,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason:
                        'AgentCore Gateway auto-managed service role. The wildcard on ' +
                        'aws:SourceArn (`gateway/<name>*`) lets the same role serve ' +
                        'every version of the same gateway — the L2 default.',
                },
            ],
            true,
        );
    }
}
