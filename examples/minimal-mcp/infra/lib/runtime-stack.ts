import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { aws_bedrockagentcore as agentcore } from 'aws-cdk-lib';
import { AgentCoreRuntime, type IdentityProvider } from '@mcp-savvy/cdk';
import { Construct } from 'constructs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Inputs for the runtime stack. */
export interface RuntimeStackProps extends cdk.StackProps {
    /**
     * Identity provider (Cognito or external OIDC) gating the runtime.
     * Pass either a pre-built provider, or a factory that's invoked
     * inside the stack so its constructs (e.g. imported user pools)
     * live in the right scope.
     */
    readonly identityProvider:
    | IdentityProvider
    | ((scope: Construct) => IdentityProvider);
    /**
     * Override the AgentCore runtime name. Defaults to `mcp_savvy_demo`;
     * the Entra parallel deploys use `mcp_savvy_demo_entra` so the two
     * stacks coexist in the same region.
     */
    readonly runtimeName?: string;
}

/**
 * AgentCore Runtime for the mcp-savvy minimal-mcp demo.
 *
 * Thin wrapper around `@mcp-savvy/cdk`'s `AgentCoreRuntime` construct
 * — the stack's job is to build the agent Docker asset, hand the
 * identity provider through, and emit the cross-stack outputs the
 * Makefile reads to compose `MCP_SAVVY_REMOTE_URL`.
 */
export class RuntimeStack extends cdk.Stack {
    public readonly runtime: AgentCoreRuntime;

    constructor(scope: Construct, id: string, props: RuntimeStackProps) {
        super(scope, id, props);

        const artifact = agentcore.AgentRuntimeArtifact.fromAsset(
            path.join(HERE, '..', '..', 'agent'),
        );

        const identityProvider =
            typeof props.identityProvider === 'function'
                ? props.identityProvider(this)
                : props.identityProvider;

        this.runtime = new AgentCoreRuntime(this, 'Runtime', {
            identityProvider,
            agentRuntimeArtifact: artifact,
            runtimeName: props.runtimeName ?? 'mcp_savvy_demo',
            description: 'mcp-savvy minimal-mcp demo: echoes its input over MCP.',
        });

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

        cdk.Tags.of(this).add('Project', 'mcp-savvy-demo');
    }
}
