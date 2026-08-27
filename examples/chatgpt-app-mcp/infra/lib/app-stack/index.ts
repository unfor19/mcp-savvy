/**
 * App stack for the chatgpt-app-mcp example (Pattern D).
 *
 * One stack ships the entire serving topology: the Lambda, the
 * public REST API Gateway with a Cognito User Pool Authorizer +
 * Request Validator, the regional WAF Web ACL, the API Gateway
 * custom domain, and the Route 53 alias to it.
 *
 * The Lambda runs in private isolated subnets with no NAT gateway
 * or internet gateway. It reaches CloudWatch Logs and DynamoDB only
 * through VPC endpoints supplied by the network stack.
 *
 * IAM stays surgical: GetItem on `customer_data`, PutItem on
 * `audit_log` (append-only by design), Put + UpdateItem on
 * `secure_view_refs`. No KMS grants — DynamoDB uses AWS-managed
 * keys.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { bundleServerCode } from './bundling.js';
import { wireRestApi } from './api.js';
import { associateWebAclToStage, buildRegionalWebAcl, stageArnFor } from './waf.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Example root: `examples/chatgpt-app-mcp/`. */
const EXAMPLE_ROOT = path.resolve(HERE, '..', '..', '..');
/** Absolute path to the Lambda source directory. */
const SERVER_SRC_DIR = path.resolve(EXAMPLE_ROOT, 'server');

/** Inputs for `AppStack`. */
export interface AppStackProps extends cdk.StackProps {
    /** VPC the MCP Lambda runs in. */
    readonly vpc: ec2.IVpc;
    /** Security group attached to the MCP Lambda. */
    readonly lambdaSecurityGroup: ec2.ISecurityGroup;
    /** Public custom domain (FQDN) bound to the API Gateway. */
    readonly domain: string;
    /** Public URL — `https://${domain}`. Used by Cognito and the Lambda. */
    readonly publicUrl: string;
    /** ACM cert ARN covering `domain`. Same region as the API Gateway. */
    readonly certificateArn: string;
    /** Route 53 hosted zone ID for `domain`'s parent zone. Optional — skip to manage DNS by hand. */
    readonly hostedZoneId?: string;
    /** Parent zone name; required when `hostedZoneId` is set. */
    readonly hostedZoneName?: string;
    /** Cognito user pool the API Gateway authorizer validates JWTs against. */
    readonly cognitoUserPool: cognito.IUserPool;
    /** Cognito issuer URL — emitted in the well-known protected-resource doc. */
    readonly cognitoIssuerUrl: string;
    /** Cognito Hosted UI URL — used by the Lambda to build well-known docs. */
    readonly cognitoHostedUiUrl: string;
    /** Customer-data DynamoDB table the tool reads from. */
    readonly customerDataTable: dynamodb.ITable;
    /** Secure-view-refs DynamoDB table the tool mints into and the widget redeems against. */
    readonly secureViewRefsTable: dynamodb.ITable;
    /** Append-only audit-log DynamoDB table the tool writes to. */
    readonly auditLogTable: dynamodb.ITable;
    /** Branches DynamoDB table the `list_branches` tool reads from. */
    readonly branchesTable: dynamodb.ITable;
    /** Required OAuth scope (e.g. `<resource-server>/balance.read`). */
    readonly requiredScope: string;
}

/** Lambda + Public REST API + WAF + custom domain + Route 53 alias. */
export class AppStack extends cdk.Stack {
    /** The MCP server Lambda. */
    public readonly mcpFn: lambda.Function;
    /** Public REST API in front of the Lambda. */
    public readonly api: apigateway.RestApi;
    /** Custom domain bound to the API. */
    public readonly domainName: apigateway.DomainName;

    constructor(scope: Construct, id: string, props: AppStackProps) {
        super(scope, id, props);

        this.mcpFn = this.buildMcpLambda(props);
        this.grantDdbAccess(props);

        const { api, domainName } = wireRestApi(this, 'McpApi', {
            mcpFn: this.mcpFn,
            cognitoUserPool: props.cognitoUserPool,
            requiredScope: props.requiredScope,
            domain: props.domain,
            certificateArn: props.certificateArn,
        });
        this.api = api;
        this.domainName = domainName;

        this.attachWaf();
        this.maybeWireRoute53Alias(props);
        this.exportOutputs(props);
        this.applyLambdaNagSuppressions();
        cdk.Tags.of(this).add('Project', 'mcp-savvy-chatgpt-app');
    }

    /** Build the MCP server Lambda; auth runs upstream at the API Gateway. */
    private buildMcpLambda(props: AppStackProps): lambda.Function {
        const mcpFnLogs = new logs.LogGroup(this, 'McpFnLogs', {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        return new lambda.Function(this, 'McpFn', {
            runtime: lambda.Runtime.NODEJS_22_X,
            architecture: lambda.Architecture.ARM_64,
            handler: 'index.handler',
            code: bundleServerCode(SERVER_SRC_DIR),
            timeout: cdk.Duration.seconds(15),
            memorySize: 512,
            reservedConcurrentExecutions: 10,
            vpc: props.vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            securityGroups: [props.lambdaSecurityGroup],
            allowPublicSubnet: false,
            environment: {
                RESOURCE_URL: props.publicUrl,
                OIDC_ISSUER: props.cognitoIssuerUrl,
                OIDC_REQUIRED_SCOPES: props.requiredScope,
                COGNITO_HOSTED_UI_URL: props.cognitoHostedUiUrl,
                CUSTOMER_DATA_TABLE_NAME: props.customerDataTable.tableName,
                AUDIT_LOG_TABLE_NAME: props.auditLogTable.tableName,
                SECURE_VIEW_REFS_TABLE_NAME: props.secureViewRefsTable.tableName,
                BRANCHES_TABLE_NAME: props.branchesTable.tableName,
            },
            logGroup: mcpFnLogs,
            description:
                'mcp-savvy chatgpt-app-mcp MCP server. Auth runs at the upstream ' +
                'API Gateway; this Lambda just dispatches MCP JSON-RPC + writes audit.',
        });
    }

    /**
     * Surgical DDB grants:
     *   - customer_data: GetItem only
     *   - audit_log: PutItem only (append-only by design)
     *   - secure_view_refs: PutItem (mint) + UpdateItem (redeem)
     *   - branches: Scan (full-table read; the table is small + public)
     */
    private grantDdbAccess(props: AppStackProps): void {
        props.customerDataTable.grant(this.mcpFn, 'dynamodb:GetItem');
        props.auditLogTable.grant(this.mcpFn, 'dynamodb:PutItem');
        props.secureViewRefsTable.grant(this.mcpFn, 'dynamodb:PutItem', 'dynamodb:UpdateItem');
        props.branchesTable.grant(this.mcpFn, 'dynamodb:Scan');
    }

    /** Build the regional WebACL and associate it with the API stage. */
    private attachWaf(): void {
        const webAcl = buildRegionalWebAcl(this, 'WebAcl');
        const stageArn = stageArnFor(this, this.api.restApiId, this.api.deploymentStage.stageName);
        associateWebAclToStage(this, 'WebAclAssoc', webAcl, stageArn);
    }

    /** Route 53 alias from the user-supplied hosted zone to the API Gateway custom domain. */
    private maybeWireRoute53Alias(props: AppStackProps): void {
        if (!props.hostedZoneId || !props.hostedZoneName) return;
        const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
            hostedZoneId: props.hostedZoneId,
            zoneName: props.hostedZoneName,
        });
        new route53.ARecord(this, 'ApiAlias', {
            zone,
            recordName: props.domain,
            target: route53.RecordTarget.fromAlias(new targets.ApiGatewayDomain(this.domainName)),
            comment: `mcp-savvy chatgpt-app ${props.domain} → API Gateway`,
        });
    }

    /** CFN outputs the example's Make targets read. */
    private exportOutputs(props: AppStackProps): void {
        new cdk.CfnOutput(this, 'McpFunctionName', { value: this.mcpFn.functionName });
        new cdk.CfnOutput(this, 'McpFunctionArn', { value: this.mcpFn.functionArn });
        new cdk.CfnOutput(this, 'PublicUrl', {
            value: props.publicUrl,
            description: 'Public URL ChatGPT calls — paste this + `/mcp` into the connector setup.',
        });
        new cdk.CfnOutput(this, 'McpEndpoint', {
            value: `${props.publicUrl}/mcp`,
            description: 'MCP endpoint — exact URL ChatGPT calls.',
        });
        new cdk.CfnOutput(this, 'RestApiId', { value: this.api.restApiId });
    }

    /** cdk-nag suppressions for the MCP Lambda. */
    private applyLambdaNagSuppressions(): void {
        NagSuppressions.addResourceSuppressions(
            this.mcpFn,
            [
                {
                    id: 'AwsSolutions-L1',
                    reason:
                        'NODEJS_22_X is the current AWS-supported latest Node Lambda ' +
                        "runtime; cdk-nag's internal 'latest' map lags releases.",
                },
                {
                    id: 'AwsSolutions-IAM4',
                    reason:
                        'L2 Lambda execution role uses AWSLambdaBasicExecutionRole + ' +
                        'AWSLambdaVPCAccessExecutionRole, the AWS-managed policies that grant ' +
                        "CloudWatch Logs writes for the function's own log group and the " +
                        'minimum ENI permissions needed to attach to the VPC. Standard L2 ' +
                        'defaults for any in-VPC Lambda.',
                    appliesTo: [
                        'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
                        'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
                    ],
                },
            ],
            true,
        );
    }
}
