/**
 * CloudFormation custom-resource handler for
 * `OAuthCompleteSessionApi`'s workload-identity registration.
 *
 * Two SDK calls in sequence:
 *   1. `GetGateway(gatewayId)` to resolve the runtime
 *      `workloadIdentityArn`. The L2 gateway appends a 10-character
 *      suffix to the workload-identity name at create time
 *      (`<gatewayName>-<random>`); this name is not exposed as a
 *      CFN attribute, so we must look it up.
 *   2. `UpdateWorkloadIdentity(name, allowedResourceOauth2ReturnUrls)`
 *      to attach the bridge's loopback callback URLs.
 *
 * Doing both in a single Lambda eliminates the eventual-consistency
 * race we'd otherwise hit with two separate `AwsCustomResource`
 * constructs (each emits its own `AWS::IAM::Policy` against the
 * shared singleton role; CFN can run the second invocation before
 * the second policy attaches).
 */

import {
    BedrockAgentCoreControlClient,
    GetGatewayCommand,
    UpdateWorkloadIdentityCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

/** Shape of the CFN custom-resource event. */
interface CustomResourceEvent {
    readonly RequestType: 'Create' | 'Update' | 'Delete';
    readonly PhysicalResourceId?: string;
    readonly ResourceProperties: {
        readonly GatewayId?: string;
        readonly LoopbackUrls?: string;
    };
}

/** Shape of the CFN custom-resource response. */
interface CustomResourceResponse {
    readonly PhysicalResourceId: string;
    readonly Data?: Record<string, string | number>;
}

const client = new BedrockAgentCoreControlClient({});

/** Lambda entrypoint. */
export async function handler(event: CustomResourceEvent): Promise<CustomResourceResponse> {
    if (event.RequestType === 'Delete') {
        // The workload identity is destroyed with the gateway; an
        // UpdateWorkloadIdentity here would race and fail.
        return { PhysicalResourceId: event.PhysicalResourceId ?? 'register/none' };
    }
    const gatewayId = event.ResourceProperties.GatewayId;
    const loopbackUrls = (event.ResourceProperties.LoopbackUrls ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter((s): s is string => s.length > 0);
    if (!gatewayId) throw new Error('GatewayId property is required');
    if (loopbackUrls.length === 0) throw new Error('LoopbackUrls property is required');

    const gateway = await client.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }));
    const arn = gateway.workloadIdentityDetails?.workloadIdentityArn;
    if (!arn) {
        throw new Error('Gateway returned no workloadIdentityDetails.workloadIdentityArn');
    }
    const segments = arn.split('/workload-identity/');
    if (segments.length !== 2 || !segments[1]) {
        throw new Error(`Unexpected workloadIdentityArn shape: ${arn}`);
    }
    const workloadIdentityName = segments[1];

    await client.send(
        new UpdateWorkloadIdentityCommand({
            name: workloadIdentityName,
            allowedResourceOauth2ReturnUrls: loopbackUrls,
        }),
    );

    return {
        PhysicalResourceId: `register/${gatewayId}`,
        Data: { workloadIdentityName, registeredUrls: loopbackUrls.length },
    };
}
