/**
 * DynamoDB read wrappers for the chatgpt-app-mcp Lambda.
 *
 * Two read paths today:
 *   - `getCustomer(userSub)` — single GetItem against `customer_data`.
 *     Returns `null` when no row exists. The Lambda role grants
 *     `dynamodb:GetItem` only on this table.
 *   - `listBranches()` — Scan against `branches` (50-row demo table;
 *     paginated for safety, ConsistentRead off). Branches are
 *     public, non-sensitive data shared across users.
 *
 * The DynamoDB client is created once at module load so the
 * connection pool is reused across warm invocations. Tests inject
 * a stub via `setClient()` to bypass the AWS SDK at unit-test time.
 */

import { DynamoDBClient, GetItemCommand, ScanCommand } from '@aws-sdk/client-dynamodb';

let client = new DynamoDBClient({});

/**
 * Override the DynamoDB client used by all read functions in this
 * module. Test-only; production code should never call this. Pass
 * `null` to restore the default client.
 */
export function setClient(stub) {
    client = stub === null ? new DynamoDBClient({}) : stub;
}

/** Read the customer row for `userSub`. Returns `null` when absent. */
export async function getCustomer(userSub) {
    if (!userSub) return null;
    const tableName = process.env.CUSTOMER_DATA_TABLE_NAME;
    if (!tableName) {
        throw new Error('CUSTOMER_DATA_TABLE_NAME env var not configured');
    }
    const cmd = new GetItemCommand({
        TableName: tableName,
        Key: { user_sub: { S: userSub } },
        ConsistentRead: false,
    });
    const result = await client.send(cmd);
    if (!result.Item) return null;
    return decodeAttributeMap(result.Item);
}

/**
 * Scan all rows from the `branches` table. Returns an array
 * (possibly empty). The table is small (~50 rows for the demo) so
 * a full scan is fine; pagination is wired defensively in case
 * the table ever grows beyond a single page.
 */
export async function listBranches() {
    const tableName = process.env.BRANCHES_TABLE_NAME;
    if (!tableName) {
        throw new Error('BRANCHES_TABLE_NAME env var not configured');
    }
    const items = [];
    let exclusiveStartKey;
    do {
        const cmd = new ScanCommand({
            TableName: tableName,
            ConsistentRead: false,
            ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        });
        const result = await client.send(cmd);
        for (const item of result.Items ?? []) items.push(decodeAttributeMap(item));
        exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items;
}

/** Convert a DynamoDB AttributeValue map back to plain JS values. */
function decodeAttributeMap(item) {
    const out = {};
    for (const [key, value] of Object.entries(item)) {
        out[key] = decodeAttributeValue(value);
    }
    return out;
}

function decodeAttributeValue(value) {
    if (value.S !== undefined) return value.S;
    if (value.N !== undefined) return Number(value.N);
    if (value.BOOL !== undefined) return value.BOOL;
    if (value.NULL === true) return null;
    if (value.SS !== undefined) return value.SS;
    if (value.NS !== undefined) return value.NS.map(Number);
    if (value.L !== undefined) return value.L.map(decodeAttributeValue);
    if (value.M !== undefined) return decodeAttributeMap(value.M);
    return undefined;
}
