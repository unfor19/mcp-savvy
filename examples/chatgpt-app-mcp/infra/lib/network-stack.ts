/**
 * Network stack for the chatgpt-app-mcp example (Pattern D).
 *
 * Provisions just enough VPC plumbing for the Lambda to run in a
 * private-isolated subnet with no internet egress. The Lambda
 * doesn't strictly need a VPC for our DynamoDB-only data tier,
 * but the demo intentionally puts it in one to mirror what a real
 * banking deployment looks like — the same Lambda would be
 * querying a private RDS / Aurora instance, an internal microservice,
 * or a private VPC-only API.
 *
 *   - VPC with 2 AZs (configurable), private-isolated subnets only.
 *     No NAT, no IGW. Lambda reaches AWS services only via VPC
 *     endpoints.
 *   - VPC flow logs to CloudWatch (1-week retention).
 *   - Interface endpoint: `logs` (private DNS on) so Lambda can
 *     write to CloudWatch Logs without internet egress.
 *   - Gateway endpoint: `dynamodb` (free).
 *   - Lambda security group with default egress; the App stack
 *     attaches the Lambda function to it.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/** Inputs for `NetworkStack`. */
export interface NetworkStackProps extends cdk.StackProps {
    /** Number of AZs to span. Defaults to 2. */
    readonly azCount?: number;
}

/** VPC + endpoints + Lambda SG for the chatgpt-app-mcp example. */
export class NetworkStack extends cdk.Stack {
    /** The private VPC. */
    public readonly vpc: ec2.Vpc;
    /** Security group attached to the MCP Lambda by the App stack. */
    public readonly lambdaSecurityGroup: ec2.SecurityGroup;

    constructor(scope: Construct, id: string, props: NetworkStackProps = {}) {
        super(scope, id, props);

        const azCount = props.azCount ?? 2;
        if (azCount < 1 || azCount > 3) {
            throw new Error(`azCount must be 1, 2, or 3 (got ${azCount}).`);
        }

        this.vpc = this.buildVpc(azCount);
        this.lambdaSecurityGroup = this.buildLambdaSecurityGroup();
        const vpceSg = this.buildVpceSecurityGroup();
        this.wireVpcEndpoints(vpceSg);
        this.exportOutputs(azCount);
        this.applyNagSuppressions();

        cdk.Tags.of(this).add('Project', 'mcp-savvy-chatgpt-app');
    }

    /** Private-isolated VPC + flow logs to CloudWatch. */
    private buildVpc(azCount: number): ec2.Vpc {
        const flowLogs = new logs.LogGroup(this, 'VpcFlowLogs', {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        return new ec2.Vpc(this, 'Vpc', {
            vpcName: 'mcp-savvy-chatgpt-app',
            ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
            maxAzs: azCount,
            natGateways: 0,
            createInternetGateway: false,
            subnetConfiguration: [
                {
                    name: 'private',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                    cidrMask: 22,
                },
            ],
            flowLogs: {
                cw: {
                    destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogs),
                    trafficType: ec2.FlowLogTrafficType.REJECT,
                },
            },
        });
    }

    /** Lambda SG: default egress (to VPCEs only), no ingress. */
    private buildLambdaSecurityGroup(): ec2.SecurityGroup {
        return new ec2.SecurityGroup(this, 'LambdaSg', {
            vpc: this.vpc,
            description: 'mcp-savvy chatgpt-app MCP Lambda - egress to VPCEs only.',
            allowAllOutbound: true,
        });
    }

    /** VPCE SG: ingress 443 from Lambda SG only. */
    private buildVpceSecurityGroup(): ec2.SecurityGroup {
        const sg = new ec2.SecurityGroup(this, 'VpceSg', {
            vpc: this.vpc,
            description: 'mcp-savvy chatgpt-app interface VPCEs - ingress 443 from Lambda SG only.',
            allowAllOutbound: false,
        });
        sg.addIngressRule(this.lambdaSecurityGroup, ec2.Port.tcp(443), 'TLS from MCP Lambda');
        return sg;
    }

    /** logs interface endpoint + dynamodb gateway endpoint. */
    private wireVpcEndpoints(vpceSecurityGroup: ec2.SecurityGroup): void {
        new ec2.InterfaceVpcEndpoint(this, 'LogsVpce', {
            vpc: this.vpc,
            service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
            privateDnsEnabled: true,
            securityGroups: [vpceSecurityGroup],
            lookupSupportedAzs: true,
        });
        this.vpc.addGatewayEndpoint('DynamoDbVpce', {
            service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
        });
    }

    /** CFN outputs the App stack consumes. */
    private exportOutputs(azCount: number): void {
        new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
        new cdk.CfnOutput(this, 'LambdaSecurityGroupId', {
            value: this.lambdaSecurityGroup.securityGroupId,
        });
        new cdk.CfnOutput(this, 'PrivateSubnetIds', {
            value: this.vpc.isolatedSubnets.map((s) => s.subnetId).join(','),
        });
        new cdk.CfnOutput(this, 'AzCount', { value: String(azCount) });
    }

    /** cdk-nag suppressions for the VPC + VPCE SG. */
    private applyNagSuppressions(): void {
        // The VPCE SG's ingress is `Peer.securityGroupId(lambdaSg.securityGroupId)`,
        // a token. cdk-nag's CdkNagValidationFailure on EC23 fires
        // when the rule fails to evaluate intra-SG ingress with that
        // token. The actual ingress is the Lambda SG ID, not 0.0.0.0/0.
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `${this.stackName}/VpceSg/Resource`,
            [
                {
                    id: 'CdkNagValidationFailure',
                    reason:
                        'EC23 rule cannot evaluate intra-SG ingress with an Fn::GetAtt token. ' +
                        'The actual ingress is the Lambda SG ID, not a CIDR.',
                },
            ],
        );
    }
}
