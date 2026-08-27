#!/usr/bin/env node
/**
 * Trigger a Bedrock Knowledge Base ingestion job and poll until
 * COMPLETE (or fail loudly).
 *
 * Inputs (supplied by the Makefile target):
 *   MCP_SAVVY_KB_ID         — knowledge-base id from `KbStack`
 *   MCP_SAVVY_KB_DS_ID      — data-source id from `KbStack`
 *   AWS_REGION              — region for the agent client
 *
 * Run via `make example-kb-ingest` (don't invoke directly unless you
 * have the env vars).
 */

import { setTimeout as sleep } from 'node:timers/promises';
import {
    BedrockAgentClient,
    StartIngestionJobCommand,
    GetIngestionJobCommand,
} from '@aws-sdk/client-bedrock-agent';

const KB_ID = process.env.MCP_SAVVY_KB_ID;
const DS_ID = process.env.MCP_SAVVY_KB_DS_ID;
const REGION = process.env.AWS_REGION ?? 'us-east-1';
if (!KB_ID || !DS_ID) {
    console.error('missing env: MCP_SAVVY_KB_ID and MCP_SAVVY_KB_DS_ID');
    process.exit(2);
}

const client = new BedrockAgentClient({ region: REGION });

const POLL_INTERVAL_MS = 5_000;
const MAX_POLLS = 120; // 10 minutes

async function main() {
    console.log(`starting ingestion job kb=${KB_ID} ds=${DS_ID}`);
    const start = await client.send(
        new StartIngestionJobCommand({
            knowledgeBaseId: KB_ID,
            dataSourceId: DS_ID,
        }),
    );
    const jobId = start.ingestionJob?.ingestionJobId;
    if (!jobId) {
        throw new Error('no ingestionJobId returned from StartIngestionJob');
    }
    console.log(`ingestion job started: ${jobId}`);

    for (let i = 0; i < MAX_POLLS; i += 1) {
        const get = await client.send(
            new GetIngestionJobCommand({
                knowledgeBaseId: KB_ID,
                dataSourceId: DS_ID,
                ingestionJobId: jobId,
            }),
        );
        const job = get.ingestionJob;
        const status = job?.status ?? 'UNKNOWN';
        const stats = job?.statistics ?? {};
        const scanned = stats.numberOfDocumentsScanned ?? 0;
        const indexed = stats.numberOfNewDocumentsIndexed ?? 0;
        const failed = stats.numberOfDocumentsFailed ?? 0;
        process.stdout.write(
            `\r[${String(i).padStart(3, ' ')}] status=${status} scanned=${scanned} indexed=${indexed} failed=${failed}    `,
        );
        if (status === 'COMPLETE') {
            console.log('\nkb-ingest done.');
            if (failed > 0) {
                console.warn(
                    `WARN: ${failed} document(s) failed during ingestion.`,
                );
            }
            return;
        }
        if (status === 'FAILED') {
            const reasons =
                (job?.failureReasons ?? []).join('; ') || 'unknown reason';
            console.error(`\nkb-ingest failed: ${reasons}`);
            process.exit(1);
        }
        await sleep(POLL_INTERVAL_MS);
    }
    console.error(
        `\nkb-ingest did not complete within ${MAX_POLLS * POLL_INTERVAL_MS / 1000}s. ` +
        'Check the AWS console for the ingestion job status.',
    );
    process.exit(1);
}

main().catch((err) => {
    console.error(`kb-ingest failed: ${err.stack ?? err.message ?? err}`);
    process.exit(1);
});
