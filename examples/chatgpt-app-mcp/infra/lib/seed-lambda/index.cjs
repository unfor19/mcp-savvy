/**
 * Seed Lambda for the chatgpt-app-mcp data stack.
 *
 * Backs a CloudFormation custom resource that loads JSON fixtures
 * into one or more DynamoDB tables on stack Create and Update
 * events. Idempotent by design: every row is written via
 * `BatchWriteItem` `PutRequest`, which overwrites an existing item
 * with the same primary key — re-running the deploy reconciles
 * fixtures rather than duplicating them.
 *
 * Multi-table mode (current): pass `SEED_TARGETS_JSON` env var, a
 * JSON array of `{ tableName, fixturesFile }` entries. The handler
 * loops over them and seeds each in sequence.
 *
 * Legacy single-table mode (still supported): if
 * `SEED_TARGETS_JSON` is unset and `TABLE_NAME` is set, the
 * handler treats it as `[{ tableName: TABLE_NAME, fixturesFile:
 * 'customer-fixtures.json' }]`. Existing tests rely on this.
 *
 * CJS, no esbuild bundle: `@aws-sdk/client-dynamodb` ships in the
 * Node 22 Lambda runtime. The asset directory carries `index.cjs`
 * plus the fixtures JSON files copied in at synth time.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DYNAMO_BATCH_LIMIT = 25;

/** Read a fixtures JSON file from disk and validate the top-level shape. */
function readFixtures(fixturesPath) {
    const raw = fs.readFileSync(fixturesPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items)) {
        throw new Error(`Fixtures file ${fixturesPath} missing top-level "items" array`);
    }
    for (const item of parsed.items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`Fixtures file ${fixturesPath} contains a non-object item`);
        }
        // Customer fixtures require user_sub. Branch fixtures don't
        // (they use branch_id). The seed Lambda is schema-agnostic —
        // the per-fixture validation lives in dataset-specific tests.
    }
    return parsed.items;
}

/** Convert a JS value to a single DynamoDB AttributeValue. */
function toAttributeValue(value) {
    if (typeof value === 'string') return { S: value };
    if (typeof value === 'number' && Number.isFinite(value)) return { N: String(value) };
    if (typeof value === 'boolean') return { BOOL: value };
    if (value === null) return { NULL: true };
    if (Array.isArray(value)) return { L: value.map(toAttributeValue) };
    if (typeof value === 'object') {
        const m = {};
        for (const [k, v] of Object.entries(value)) m[k] = toAttributeValue(v);
        return { M: m };
    }
    throw new Error(`Unsupported attribute type: ${typeof value}`);
}

/** Convert a plain JS object into the AttributeValue map DynamoDB expects. */
function toAttributeValueMap(item) {
    const out = {};
    for (const [key, value] of Object.entries(item)) {
        out[key] = toAttributeValue(value);
    }
    return out;
}

/** Split an array into chunks of at most `size` elements. */
function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) {
        out.push(arr.slice(i, i + size));
    }
    return out;
}

/**
 * Seed `tableName` with the fixtures at `fixturesPath` via
 * `BatchWriteItem`. The DynamoDB client is dependency-injected so
 * the unit test can stub it. Returns `{ itemCount, batchCount }`.
 */
async function runSeed({ ddbClient, fixturesPath, tableName }) {
    if (!ddbClient || typeof ddbClient.send !== 'function') {
        throw new Error('runSeed requires a DynamoDB client with a send() method');
    }
    if (!tableName) throw new Error('runSeed requires a tableName');
    const items = readFixtures(fixturesPath);
    const batches = chunk(items, DYNAMO_BATCH_LIMIT);
    let batchCount = 0;
    for (const batch of batches) {
        const requestItems = {
            [tableName]: batch.map((item) => ({
                PutRequest: { Item: toAttributeValueMap(item) },
            })),
        };
        const command = {
            __batchWrite: true,
            input: { RequestItems: requestItems },
        };
        await ddbClient.send(command);
        batchCount += 1;
    }
    return { itemCount: items.length, batchCount };
}

/**
 * Resolve seed targets from env vars. New `SEED_TARGETS_JSON` wins;
 * legacy `TABLE_NAME` is a single-customer fallback for back-compat
 * with existing tests.
 */
function parseSeedTargets() {
    const json = process.env.SEED_TARGETS_JSON;
    if (json) {
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed) || parsed.length === 0) {
            throw new Error('SEED_TARGETS_JSON must be a non-empty array');
        }
        for (const t of parsed) {
            if (!t || typeof t.tableName !== 'string' || typeof t.fixturesFile !== 'string') {
                throw new Error('SEED_TARGETS_JSON entries must have { tableName, fixturesFile }');
            }
        }
        return parsed;
    }
    if (process.env.TABLE_NAME) {
        return [{ tableName: process.env.TABLE_NAME, fixturesFile: 'customer-fixtures.json' }];
    }
    throw new Error('Either SEED_TARGETS_JSON or TABLE_NAME env var is required');
}

/**
 * Build the CFN custom-resource response. Delete is a no-op:
 * deletion protection on the tables will normally prevent removal,
 * and even when destroyed, the rows go with the table.
 */
async function handler(event) {
    const requestType = event && event.RequestType;
    const targets = parseSeedTargets();
    const physicalId = `seed/${targets.map((t) => t.tableName).join(',')}`;
    if (requestType === 'Delete') {
        return { PhysicalResourceId: event.PhysicalResourceId || physicalId };
    }
    const { DynamoDBClient, BatchWriteItemCommand } = require('@aws-sdk/client-dynamodb');
    const ddbClient = new DynamoDBClient({});
    const sendingClient = {
        send: (cmd) => ddbClient.send(new BatchWriteItemCommand(cmd.input)),
    };
    const results = [];
    for (const t of targets) {
        const fixturesPath = path.join(__dirname, t.fixturesFile);
        const r = await runSeed({ ddbClient: sendingClient, fixturesPath, tableName: t.tableName });
        results.push({ table: t.tableName, ...r });
    }
    return {
        PhysicalResourceId: physicalId,
        Data: { seeded: JSON.stringify(results) },
    };
}

module.exports = {
    handler,
    runSeed,
    readFixtures,
    toAttributeValueMap,
    toAttributeValue,
    parseSeedTargets,
};
