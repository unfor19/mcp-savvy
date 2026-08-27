/**
 * Append-only audit log writer for the chatgpt-app-mcp Lambda.
 *
 * Every tool call writes two events: `<action>_requested` on entry
 * and `<action>_completed` (or `<action>_failed`) on exit. The
 * Lambda role grants `dynamodb:PutItem` on the `audit_log` table
 * only — no `Update*`, no `Delete*`, ever. Items expire 30 days
 * after creation via the `ttl_expires_at` TTL attribute.
 *
 * Audit rows never carry the raw `sub` claim or any balance values:
 * `sub` is hashed to `user_sub_hash` (SHA-256 hex) and the action
 * payload is a small set of bounded strings. Failures inside the
 * audit writer are logged but do NOT propagate — refusing to serve
 * the user because we couldn't write a log entry would be the wrong
 * trade-off.
 */

import { createHash, randomUUID } from 'node:crypto';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';

const TTL_DAYS = 30;
const SECONDS_PER_DAY = 86_400;

let client = new DynamoDBClient({});

/** Test-only override of the DynamoDB client used by `writeAuditEvent`. */
export function setClient(stub) {
    client = stub === null ? new DynamoDBClient({}) : stub;
}

/** SHA-256 hex of the JWT subject; never includes the raw value in audit logs. */
export function hashSubject(userSub) {
    return createHash('sha256').update(userSub, 'utf8').digest('hex');
}

/**
 * Write one audit event. `action` is the snake_case verb (e.g.
 * `balance_read_requested`). `correlationId` ties paired events
 * together; the caller mints one and reuses it across requested +
 * completed/failed.
 */
export async function writeAuditEvent({
    action,
    userSubHash,
    correlationId,
    status,
    metadata,
}) {
    const tableName = process.env.AUDIT_LOG_TABLE_NAME;
    if (!tableName) {
        console.error('AUDIT_LOG_TABLE_NAME env var not configured; skipping audit write');
        return;
    }
    const now = new Date();
    const createdAt = now.toISOString();
    const ttl = Math.floor(now.getTime() / 1000) + TTL_DAYS * SECONDS_PER_DAY;
    const item = {
        event_id: { S: randomUUID() },
        created_at: { S: createdAt },
        ttl_expires_at: { N: String(ttl) },
        action: { S: action },
        user_sub_hash: { S: userSubHash },
        correlation_id: { S: correlationId },
        status: { S: status },
    };
    if (metadata && typeof metadata === 'object') {
        for (const [key, value] of Object.entries(metadata)) {
            if (typeof value === 'string') {
                item[`meta_${key}`] = { S: value };
            }
        }
    }
    try {
        await client.send(new PutItemCommand({ TableName: tableName, Item: item }));
    } catch (err) {
        console.error(
            'audit write failed:',
            err instanceof Error ? err.message : String(err),
        );
    }
}

/** Mint a fresh correlation ID; pair with `writeAuditEvent`. */
export function newCorrelationId() {
    return randomUUID();
}
