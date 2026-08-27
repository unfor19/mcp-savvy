/**
 * Regional AWS WAF WebACL + association for the chatgpt-app-mcp
 * REST API Gateway stage.
 *
 * Pattern D ships WAF as the edge filter: AWS managed common rules,
 * known-bad-input rules, a per-IP rate limit, and a request body
 * size cap. There's no CloudFront in front of the API Gateway, so
 * the WebACL is REGIONAL scope and associates directly with the
 * API Gateway stage ARN.
 *
 * Rate limit: 200 requests / 5 minutes / IP. Body cap: 16 KiB
 * (well above any legitimate JSON-RPC envelope, well below any
 * reasonable upload).
 */

import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

const MAX_REQUESTS_PER_5_MIN_PER_IP = 200;
const MAX_REQUEST_BODY_BYTES = 16_384;

/** Build the regional WebACL for the API Gateway stage. */
export function buildRegionalWebAcl(scope: Construct, id: string): wafv2.CfnWebACL {
    return new wafv2.CfnWebACL(scope, id, {
        name: 'mcp-savvy-chatgpt-app',
        scope: 'REGIONAL',
        defaultAction: { allow: {} },
        visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'mcp-savvy-chatgpt-app',
            sampledRequestsEnabled: false,
        },
        rules: [
            managedRule('CommonRules', 1, 'AWSManagedRulesCommonRuleSet'),
            managedRule('KnownBadInputs', 2, 'AWSManagedRulesKnownBadInputsRuleSet'),
            {
                name: 'RateLimitPerIP',
                priority: 3,
                action: { block: {} },
                statement: {
                    rateBasedStatement: {
                        limit: MAX_REQUESTS_PER_5_MIN_PER_IP,
                        aggregateKeyType: 'IP',
                    },
                },
                visibilityConfig: {
                    cloudWatchMetricsEnabled: true,
                    metricName: 'RateLimitPerIP',
                    sampledRequestsEnabled: false,
                },
            },
            {
                name: 'BodySizeLimit',
                priority: 4,
                action: { block: {} },
                statement: {
                    sizeConstraintStatement: {
                        fieldToMatch: { body: {} },
                        comparisonOperator: 'GT',
                        size: MAX_REQUEST_BODY_BYTES,
                        textTransformations: [{ priority: 0, type: 'NONE' }],
                    },
                },
                visibilityConfig: {
                    cloudWatchMetricsEnabled: true,
                    metricName: 'BodySizeLimit',
                    sampledRequestsEnabled: false,
                },
            },
        ],
    });
}

/**
 * Associate the WebACL with the API Gateway stage. CDK has no L2
 * helper for this pairing, so we drop to the L1 association
 * resource. The stage ARN format is documented for `arn:aws:apigateway:...`.
 */
export function associateWebAclToStage(
    scope: Construct,
    id: string,
    webAcl: wafv2.CfnWebACL,
    stageArn: string,
): wafv2.CfnWebACLAssociation {
    return new wafv2.CfnWebACLAssociation(scope, id, {
        resourceArn: stageArn,
        webAclArn: webAcl.attrArn,
    });
}

/** Build a managed-rule entry; common name + vendor combo. */
function managedRule(name: string, priority: number, ruleSetName: string): wafv2.CfnWebACL.RuleProperty {
    return {
        name,
        priority,
        overrideAction: { none: {} },
        statement: {
            managedRuleGroupStatement: {
                vendorName: 'AWS',
                name: ruleSetName,
            },
        },
        visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: name,
            sampledRequestsEnabled: false,
        },
    };
}

/**
 * Build a stage ARN from the API Gateway L2's restApiId + stage name.
 * Format: arn:${partition}:apigateway:${region}::/restapis/${apiId}/stages/${stage}
 */
export function stageArnFor(
    scope: Construct,
    restApiId: string,
    stageName: string,
): string {
    const stack = cdk.Stack.of(scope);
    return `arn:${stack.partition}:apigateway:${stack.region}::/restapis/${restApiId}/stages/${stageName}`;
}
