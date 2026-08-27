/**
 * CloudFormation custom-resource handler that runs a Bedrock
 * Knowledge Base ingestion job as part of `cdk deploy`.
 *
 * Split across the two-phase async custom-resource contract so a
 * long-running ingestion never blocks (or times out) a single
 * Lambda invocation:
 *   - `onEvent` (Create/Update) calls `StartIngestionJob` and
 *     returns the new job id as part of the physical resource id.
 *     Delete is a no-op — the data is owned by the KB + source
 *     bucket, whose own removal policies govern teardown.
 *   - `isComplete` polls `GetIngestionJob` and reports back to CFN
 *     until the job reaches a terminal state. `cr.Provider` handles
 *     the wait/retry loop, so this handler stays a single fast call.
 *
 * Mirrors the proven `examples/kb-mcp/scripts/ingest.mjs` logic, but
 * driven by CloudFormation instead of a Makefile target.
 */

import {
    BedrockAgentClient,
    GetIngestionJobCommand,
    StartIngestionJobCommand,
} from '@aws-sdk/client-bedrock-agent';

const client = new BedrockAgentClient({});

/** Subset of the CFN custom-resource event this handler reads. */
interface OnEventRequest {
    readonly RequestType: 'Create' | 'Update' | 'Delete';
    readonly PhysicalResourceId?: string;
    readonly ResourceProperties: {
        readonly KnowledgeBaseId?: string;
        readonly DataSourceId?: string;
        /** Opaque value; changing it forces a new ingestion job. */
        readonly Trigger?: string;
    };
}

/** `onEvent` result — carries the started job id forward to `isComplete`. */
interface OnEventResponse {
    readonly PhysicalResourceId: string;
    readonly Data?: { readonly IngestionJobId: string };
}

/** `isComplete` result — CFN keeps polling until `IsComplete` is true. */
interface IsCompleteResponse {
    readonly IsComplete: boolean;
    readonly Data?: Record<string, string | number>;
}

/** Read + validate the two required ids off the event. */
function requireIds(event: OnEventRequest): {
    knowledgeBaseId: string;
    dataSourceId: string;
} {
    const knowledgeBaseId = event.ResourceProperties.KnowledgeBaseId;
    const dataSourceId = event.ResourceProperties.DataSourceId;
    if (!knowledgeBaseId) throw new Error('KnowledgeBaseId property is required');
    if (!dataSourceId) throw new Error('DataSourceId property is required');
    return { knowledgeBaseId, dataSourceId };
}

/** Start an ingestion job on Create/Update; no-op on Delete. */
export async function onEvent(event: OnEventRequest): Promise<OnEventResponse> {
    if (event.RequestType === 'Delete') {
        // The KB + source bucket own the data; their removal policies
        // govern teardown. A StartIngestionJob here would be pointless
        // and could race the KB's own deletion.
        return { PhysicalResourceId: event.PhysicalResourceId ?? 'kb-ingest/none' };
    }
    const { knowledgeBaseId, dataSourceId } = requireIds(event);
    const start = await client.send(
        new StartIngestionJobCommand({ knowledgeBaseId, dataSourceId }),
    );
    const jobId = start.ingestionJob?.ingestionJobId;
    if (!jobId) throw new Error('no ingestionJobId returned from StartIngestionJob');
    return {
        PhysicalResourceId: `kb-ingest/${knowledgeBaseId}/${dataSourceId}`,
        Data: { IngestionJobId: jobId },
    };
}

/** Poll the ingestion job until it reaches a terminal state. */
export async function isComplete(
    event: OnEventRequest & { readonly Data?: { readonly IngestionJobId?: string } },
): Promise<IsCompleteResponse> {
    if (event.RequestType === 'Delete') return { IsComplete: true };
    const jobId = event.Data?.IngestionJobId;
    if (!jobId) throw new Error('isComplete invoked without an IngestionJobId');
    const { knowledgeBaseId, dataSourceId } = requireIds(event);

    const get = await client.send(
        new GetIngestionJobCommand({
            knowledgeBaseId,
            dataSourceId,
            ingestionJobId: jobId,
        }),
    );
    const job = get.ingestionJob;
    const status = job?.status ?? 'UNKNOWN';
    const stats = job?.statistics ?? {};
    const scanned = stats.numberOfDocumentsScanned ?? 0;
    const indexed = stats.numberOfNewDocumentsIndexed ?? 0;
    const failed = stats.numberOfDocumentsFailed ?? 0;

    if (status === 'COMPLETE') {
        if (failed > 0) {
            console.warn(`kb-ingest: ${failed} document(s) failed during ingestion.`);
        }
        return {
            IsComplete: true,
            Data: { IngestionJobId: jobId, scanned, indexed, failed },
        };
    }
    if (status === 'FAILED') {
        const reasons = (job?.failureReasons ?? []).join('; ') || 'unknown reason';
        throw new Error(`kb-ingest failed: ${reasons}`);
    }
    // STARTING / IN_PROGRESS — let cr.Provider call us again.
    return { IsComplete: false };
}
