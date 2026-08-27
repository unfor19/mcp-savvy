/**
 * Data stack for the chatgpt-app-mcp example.
 *
 * Provisions the DynamoDB tables that back the banking-grade
 * ChatGPT App demo, plus a custom-resource Lambda that seeds
 * fixtures into them on every Create / Update event.
 *
 *  - `customer_data` holds synthetic customer rows keyed by
 *    `user_sub` (the Cognito JWT subject claim).
 *  - `secure_view_refs` holds 60-second single-use tokens minted
 *    by the MCP Lambda when a tool result references the
 *    sandboxed widget endpoint; TTL on `expires_at` cleans up.
 *  - `audit_log` is append-only — the MCP Lambda's role only
 *    grants `PutItem`; per-event TTL on `ttl_expires_at` enforces
 *    a 30-day retention window by default.
 *  - `branches` (v0.2) holds 50 fake Savvy branches across Israel.
 *    Public, non-sensitive demo data, keyed by `branch_id`.
 *
 * MVP encryption: `TableEncryption.AWS_MANAGED` (the AWS-managed
 * `aws/dynamodb` KMS key — automatic, free, AES-256, FIPS 140-2
 * validated). Customer-managed CMK is documented as an opt-in
 * upgrade in `SECURITY.md` section 2.4.
 */

import * as path from 'node:path';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { CustomResource, custom_resources as cr } from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Path to the example root (`examples/chatgpt-app-mcp/`). */
const EXAMPLE_ROOT = path.resolve(HERE, '..', '..');
/** Path to the seed Lambda source directory (CJS). */
const SEED_LAMBDA_DIR = path.resolve(HERE, 'seed-lambda');
/** Customer fixtures JSON copied into the asset at synth. */
const CUSTOMER_FIXTURES_PATH = path.resolve(EXAMPLE_ROOT, 'seed', 'customer-fixtures.json');
/** Branch fixtures JSON copied into the asset at synth. */
const BRANCHES_FIXTURES_PATH = path.resolve(EXAMPLE_ROOT, 'seed', 'branches-fixtures.json');

/** Inputs for `DataStack`. */
export interface DataStackProps extends cdk.StackProps {
    /**
     * Override the resource-name prefix applied to every table.
     * Defaults to `mcp-savvy-chatgpt-app`. CloudFormation logical
     * IDs (`CustomerDataTable`, etc.) stay stable across renames.
     */
    readonly resourceNamePrefix?: string;
}

/** DynamoDB tables + seed custom resource for the chatgpt-app-mcp example. */
export class DataStack extends cdk.Stack {
    /** `customer_data` — keyed by `user_sub`, seeded with fixtures. */
    public readonly customerDataTable: dynamodb.Table;
    /** `secure_view_refs` — TTL on `expires_at`. */
    public readonly secureViewRefsTable: dynamodb.Table;
    /** `audit_log` — append-only, TTL on `ttl_expires_at`. */
    public readonly auditLogTable: dynamodb.Table;
    /** `branches` — keyed by `branch_id`, seeded with 50 fake Israel rows. */
    public readonly branchesTable: dynamodb.Table;
    /** Custom resource that seeds `customer_data` + `branches` on Create / Update. */
    public readonly seedCustomResource: CustomResource;

    constructor(scope: Construct, id: string, props: DataStackProps = {}) {
        super(scope, id, props);

        const prefix = props.resourceNamePrefix ?? 'mcp-savvy-chatgpt-app';

        this.customerDataTable = new dynamodb.Table(this, 'CustomerDataTable', {
            tableName: `${prefix}-customer-data`,
            partitionKey: { name: 'user_sub', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption: dynamodb.TableEncryption.AWS_MANAGED,
            pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
            deletionProtection: true,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        this.secureViewRefsTable = new dynamodb.Table(this, 'SecureViewRefsTable', {
            tableName: `${prefix}-secure-view-refs`,
            partitionKey: { name: 'ref_id', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption: dynamodb.TableEncryption.AWS_MANAGED,
            pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
            deletionProtection: true,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            timeToLiveAttribute: 'expires_at',
        });

        this.auditLogTable = new dynamodb.Table(this, 'AuditLogTable', {
            tableName: `${prefix}-audit-log`,
            partitionKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'created_at', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption: dynamodb.TableEncryption.AWS_MANAGED,
            pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
            deletionProtection: true,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            timeToLiveAttribute: 'ttl_expires_at',
        });

        this.branchesTable = new dynamodb.Table(this, 'BranchesTable', {
            tableName: `${prefix}-branches`,
            partitionKey: { name: 'branch_id', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption: dynamodb.TableEncryption.AWS_MANAGED,
            pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
            deletionProtection: true,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        this.seedCustomResource = this.wireSeedCustomResource();

        new cdk.CfnOutput(this, 'CustomerDataTableName', {
            value: this.customerDataTable.tableName,
            description: 'DynamoDB table holding synthetic customer rows.',
        });
        new cdk.CfnOutput(this, 'SecureViewRefsTableName', {
            value: this.secureViewRefsTable.tableName,
            description: 'DynamoDB table holding 60s single-use widget refs.',
        });
        new cdk.CfnOutput(this, 'AuditLogTableName', {
            value: this.auditLogTable.tableName,
            description: 'DynamoDB table holding the append-only audit log.',
        });
        new cdk.CfnOutput(this, 'BranchesTableName', {
            value: this.branchesTable.tableName,
            description: 'DynamoDB table holding fake Savvy Israel branches.',
        });

        cdk.Tags.of(this).add('Project', 'mcp-savvy-chatgpt-app');
    }

    /**
     * Bundle the seed Lambda asset (CJS handler + both fixtures
     * files), wire it into a `cr.Provider`, and return the
     * `CustomResource` that fires on stack Create + Update.
     */
    private wireSeedCustomResource(): CustomResource {
        const seedHandlerLogs = new logs.LogGroup(this, 'SeedFnLogs', {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        const seedFn = new lambda.Function(this, 'SeedFn', {
            runtime: lambda.Runtime.NODEJS_22_X,
            architecture: lambda.Architecture.ARM_64,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(SEED_LAMBDA_DIR, {
                assetHashType: cdk.AssetHashType.OUTPUT,
                bundling: {
                    image: lambda.Runtime.NODEJS_22_X.bundlingImage,
                    local: {
                        tryBundle(outputDir: string): boolean {
                            mkdirSync(outputDir, { recursive: true });
                            copyFileSync(
                                path.join(SEED_LAMBDA_DIR, 'index.cjs'),
                                path.join(outputDir, 'index.cjs'),
                            );
                            copyFileSync(
                                CUSTOMER_FIXTURES_PATH,
                                path.join(outputDir, 'customer-fixtures.json'),
                            );
                            copyFileSync(
                                BRANCHES_FIXTURES_PATH,
                                path.join(outputDir, 'branches-fixtures.json'),
                            );
                            return true;
                        },
                    },
                    command: [
                        'bash',
                        '-c',
                        'cp /asset-input/index.cjs /asset-output/ && ' +
                        'cp /asset-input/../../seed/customer-fixtures.json /asset-output/ && ' +
                        'cp /asset-input/../../seed/branches-fixtures.json /asset-output/',
                    ],
                },
            }),
            timeout: cdk.Duration.minutes(2),
            memorySize: 256,
            environment: {
                SEED_TARGETS_JSON: cdk.Stack.of(this).toJsonString([
                    {
                        tableName: this.customerDataTable.tableName,
                        fixturesFile: 'customer-fixtures.json',
                    },
                    {
                        tableName: this.branchesTable.tableName,
                        fixturesFile: 'branches-fixtures.json',
                    },
                ]),
            },
            logGroup: seedHandlerLogs,
            description:
                'mcp-savvy chatgpt-app-mcp: seed customer_data + branches fixtures via BatchWriteItem.',
        });
        seedFn.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['dynamodb:BatchWriteItem'],
                resources: [
                    this.customerDataTable.tableArn,
                    this.branchesTable.tableArn,
                ],
            }),
        );

        const seedProviderLogs = new logs.LogGroup(this, 'SeedProviderLogs', {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        const seedProvider = new cr.Provider(this, 'SeedProvider', {
            onEventHandler: seedFn,
            logGroup: seedProviderLogs,
        });

        const customResource = new CustomResource(this, 'SeedCustomerData', {
            serviceToken: seedProvider.serviceToken,
            properties: {
                // Touching any of these on a re-deploy forces the
                // custom resource to re-run and reconcile fixtures
                // even when the asset hash hasn't changed.
                CustomerFixturesAssetHash: cdk.FileSystem.fingerprint(CUSTOMER_FIXTURES_PATH),
                BranchesFixturesAssetHash: cdk.FileSystem.fingerprint(BRANCHES_FIXTURES_PATH),
                TargetTables: cdk.Fn.join(',', [
                    this.customerDataTable.tableName,
                    this.branchesTable.tableName,
                ]),
            },
            resourceType: 'Custom::ChatGptAppSeedCustomerData',
        });

        this.applyNagSuppressions(seedFn);
        return customResource;
    }

    /** Standard cdk-nag suppressions for the seed Lambda + provider. */
    private applyNagSuppressions(seedFn: lambda.Function): void {
        NagSuppressions.addResourceSuppressions(
            seedFn,
            [
                {
                    id: 'AwsSolutions-L1',
                    reason:
                        'NODEJS_22_X is the current AWS-supported latest Node Lambda ' +
                        'runtime; cdk-nag\'s internal "latest" map lags releases.',
                },
                {
                    id: 'AwsSolutions-IAM4',
                    reason:
                        'L2 Lambda execution role uses AWSLambdaBasicExecutionRole — the ' +
                        'AWS-managed policy granting only CloudWatch Logs writes. Standard ' +
                        'L2 default and the minimum a Lambda needs.',
                    appliesTo: [
                        'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
                    ],
                },
            ],
            true,
        );
        // The cr.Provider framework Lambda is CDK-managed; we don't
        // own its runtime selection.
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/SeedProvider`,
            [
                {
                    id: 'AwsSolutions-IAM4',
                    reason:
                        'cr.Provider framework Lambda uses AWSLambdaBasicExecutionRole — ' +
                        'standard CDK default for custom-resource framework handlers.',
                },
                {
                    id: 'AwsSolutions-IAM5',
                    reason:
                        'cr.Provider framework Lambda emits a CDK-managed wildcard grant ' +
                        'to invoke the construct-owned seed handler. Deploy-time only.',
                },
                {
                    id: 'AwsSolutions-L1',
                    reason:
                        'cr.Provider framework Lambda pins a runtime CDK selects — its ' +
                        'version is CDK-managed, not this construct\'s to set.',
                },
            ],
            true,
        );
    }
}
