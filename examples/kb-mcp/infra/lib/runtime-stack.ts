import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { aws_bedrockagentcore as agentcore } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AgentCoreRuntime, type IdentityProvider } from '@mcp-savvy/cdk';
import { Construct } from 'constructs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Inputs for the kb-mcp runtime stack. */
export interface RuntimeStackProps extends cdk.StackProps {
    /** Identity provider gating the runtime. */
    readonly identityProvider:
    | IdentityProvider
    | ((scope: Construct) => IdentityProvider);
    /** Bedrock Knowledge Base id (from `KbStack`). */
    readonly knowledgeBaseId: string;
    /** Bedrock Knowledge Base ARN (from `KbStack`). Used for IAM scoping. */
    readonly knowledgeBaseArn: string;
    /** Optional override for the AgentCore runtime name. */
    readonly runtimeName?: string;
    /**
     * Bedrock model id the agent passes to `BedrockModel(model_id=...)`.
     * Defaults to the US cross-region inference profile for Claude
     * Sonnet 4.6 (`us.anthropic.claude-sonnet-4-6`). Modern Claude
     * models require an inference profile — the bare foundation-model
     * id fails with "on-demand throughput isn't supported." Pass
     * a different inference-profile id (or a foundation-model id for
     * older models that still allow on-demand invocation).
     */
    readonly generationModelId?: string;
    /**
     * Override the IAM grants the runtime role gets for invoking the
     * generation model. When unset, the construct grants
     * `bedrock:InvokeModel*` on the profile ARN in this region AND on
     * the underlying foundation-model ARNs in the profile's
     * destination regions (us-east-1, us-east-2, us-west-2 for the
     * US profile). Pass an explicit ARN list to scope to a specific
     * region or to add an EU/APAC profile.
     */
    readonly generationModelArns?: readonly string[];
}

/**
 * AgentCore Runtime for the kb-mcp demo.
 *
 * Runs the Strands agent in `agents/agentic/` — internal `kb_retrieve`
 * tool, exposes one outward MCP tool (`ask`). The system prompt
 * instructs the agent to ground answers solely on the KB and to say so
 * when the KB has nothing relevant.
 *
 * The runtime's IAM role is granted bedrock:Retrieve and
 * bedrock:RetrieveAndGenerate against the KB ARN, plus
 * bedrock:InvokeModel against the generation model.
 */
export class RuntimeStack extends cdk.Stack {
    public readonly runtime: AgentCoreRuntime;

    constructor(scope: Construct, id: string, props: RuntimeStackProps) {
        super(scope, id, props);

        const agentDir = path.join(HERE, '..', '..', 'agents', 'agentic');
        const artifact = agentcore.AgentRuntimeArtifact.fromAsset(agentDir);

        const identityProvider =
            typeof props.identityProvider === 'function'
                ? props.identityProvider(this)
                : props.identityProvider;

        const generationModelId =
            props.generationModelId ?? 'us.anthropic.claude-sonnet-4-6';
        // Scope the IAM grant. The default covers the US cross-region
        // inference profile (`us.<modelId>`): one ARN for the profile
        // itself in this stack's region, plus one for the underlying
        // foundation-model in each US destination region. Override
        // `generationModelArns` to point at a different profile (eu.,
        // apac., global.) or a single-region foundation-model.
        const profileArn = cdk.Arn.format(
            {
                service: 'bedrock',
                resource: 'inference-profile',
                resourceName: generationModelId,
            },
            this,
        );
        const fmId = generationModelId.startsWith('us.')
            ? generationModelId.slice(3)
            : generationModelId.startsWith('eu.') ||
                generationModelId.startsWith('apac.') ||
                generationModelId.startsWith('global.')
                ? generationModelId.replace(/^[a-z]+\./, '')
                : generationModelId;
        const usDestinationRegions = ['us-east-1', 'us-east-2', 'us-west-2'];
        const defaultModelArns = [
            profileArn,
            ...usDestinationRegions.map((r) =>
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
        ];
        const generationModelArns = props.generationModelArns ?? defaultModelArns;

        this.runtime = new AgentCoreRuntime(this, 'Runtime', {
            identityProvider,
            agentRuntimeArtifact: artifact,
            runtimeName: props.runtimeName ?? 'mcp_savvy_kb_demo',
            description:
                'mcp-savvy kb-mcp demo: KB-grounded agent exposing a single ask() tool.',
            environmentVariables: {
                MCP_SAVVY_KB_ID: props.knowledgeBaseId,
                MCP_SAVVY_KB_MODEL_ID: generationModelId,
            },
        });

        // Bedrock Agent Runtime grants — scoped to this KB only.
        this.runtime.role.addToPrincipalPolicy(
            new iam.PolicyStatement({
                sid: 'KbRetrieve',
                effect: iam.Effect.ALLOW,
                actions: ['bedrock:Retrieve', 'bedrock:RetrieveAndGenerate'],
                resources: [props.knowledgeBaseArn],
            }),
        );
        // The agent invokes the generation model directly (Strands +
        // ConverseStream). Grants cover the inference-profile ARN AND
        // the foundation-model ARNs in the profile's destination
        // regions; cross-region inference requires both.
        this.runtime.role.addToPrincipalPolicy(
            new iam.PolicyStatement({
                sid: 'InvokeGenerationModel',
                effect: iam.Effect.ALLOW,
                actions: [
                    'bedrock:InvokeModel',
                    'bedrock:InvokeModelWithResponseStream',
                ],
                resources: [...generationModelArns],
            }),
        );
        // Resolving a cross-region inference profile calls
        // GetInferenceProfile first (caught live on gateway-kb-mcp's
        // RetrieveAndGenerate, 2026-05-31). Grant it on the profile ARN.
        this.runtime.role.addToPrincipalPolicy(
            new iam.PolicyStatement({
                sid: 'GetInferenceProfile',
                effect: iam.Effect.ALLOW,
                actions: ['bedrock:GetInferenceProfile'],
                resources: [profileArn],
            }),
        );

        new cdk.CfnOutput(this, 'RuntimeArn', {
            value: this.runtime.agentRuntimeArn,
            description: 'AgentCore Runtime ARN — used to compose MCP_SAVVY_REMOTE_URL',
        });
        new cdk.CfnOutput(this, 'RuntimeId', {
            value: this.runtime.agentRuntimeId,
            description: 'AgentCore Runtime ID',
        });
        new cdk.CfnOutput(this, 'RuntimeRegion', {
            value: this.region,
            description: 'AWS region — used to compose MCP_SAVVY_REMOTE_URL',
        });

        cdk.Tags.of(this).add('Project', 'mcp-savvy-kb-demo');
    }
}
