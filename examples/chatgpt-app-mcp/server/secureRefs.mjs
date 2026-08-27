/**
 * Mint and redeem secure-view refs for the chatgpt-app-mcp Lambda.
 *
 * A ref is a 256-bit random token (base64url-encoded) that the tool
 * call delivers to the widget iframe via `_meta.secure_view_ref`.
 * The widget POSTs the ref back to `/widgets/balance` to fetch the
 * actual balance.
 *
 * Two safeties on every ref:
 *
 *  1. **60-second TTL** — `expires_at` (epoch seconds). DynamoDB's
 *     TTL sweep removes the row eventually, but redemption checks
 *     `expires_at` against the current clock so even pre-sweep
 *     reads enforce the deadline.
 *  2. **Single use** — redemption flips `status: unused -> used`
 *     atomically via a conditional `UpdateItem`. A second redeem
 *     attempt fails the condition and returns 410 Gone.
 *
 * Refs are bound to:
 *  - `user_sub_hash` (the SHA-256 of the JWT subject) so a stolen
 *    ref can't be redeemed by another signed-in user.
 *  - `purpose` (e.g. `credit_balance`) so a ref minted for one
 *    capability can't unlock a different one.
 *
 * The `correlation_id` is propagated end-to-end so the audit log
 * can stitch tool-call -> ref-mint -> widget-read into one timeline.
 */

import { randomBytes } from 'node:crypto';
import {
    ConditionalCheckFailedException,
    DynamoDBClient,
    PutItemCommand,
    UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';

/** TTL in seconds for the single-use widget reference. */
export const REF_TTL_SECONDS = 60;
const REF_BYTES = 32;

let client = new DynamoDBClient({});

/** Test-only override of the DynamoDB client. */
export function setClient(stub) {
    client = stub === null ? new DynamoDBClient({}) : stub;
}

/** Generate a fresh base64url-shaped ref id. */
export function newRefId() {
    return randomBytes(REF_BYTES).toString('base64url');
}

/** Thrown when a ref doesn't exist, has been used, or has expired. */
export class RefRedemptionError extends Error {
    constructor(reason, message) {
        super(message);
        this.name = 'RefRedemptionError';
        this.reason = reason;
    }
}

/**
 * Mint a fresh ref bound to `subjectHash` + `purpose`. Returns the
 * stored row so callers can include `expires_at` in their response.
 */
export async function mintRef({ subjectHash, purpose, correlationId }) {
    if (!subjectHash) throw new Error('mintRef requires subjectHash');
    if (!purpose) throw new Error('mintRef requires purpose');
    const tableName = secureViewRefsTable();
    const refId = newRefId();
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + REF_TTL_SECONDS;
    await client.send(
        new PutItemCommand({
            TableName: tableName,
            Item: {
                ref_id: { S: refId },
                user_sub_hash: { S: subjectHash },
                purpose: { S: purpose },
                created_at: { N: String(now) },
                expires_at: { N: String(expiresAt) },
                status: { S: 'unused' },
                correlation_id: { S: correlationId ?? '' },
            },
            ConditionExpression: 'attribute_not_exists(ref_id)',
        }),
    );
    return { refId, expiresAt, purpose, subjectHash, correlationId };
}

/**
 * Redeem a ref. Conditional `UpdateItem` enforces:
 *   - the ref exists
 *   - it hasn't been redeemed yet (`status = unused`)
 *   - the bound `user_sub_hash` matches the caller
 *   - the bound `purpose` matches the requested capability
 *   - it hasn't expired (`expires_at >= :now`)
 *
 * On success, returns the row's `correlation_id`. On any failed
 * predicate, throws a `RefRedemptionError` with a stable `reason`
 * the caller maps to an HTTP status (`gone`, `mismatch`, etc.).
 */
export async function redeemRef({ refId, subjectHash, purpose }) {
    if (!refId) throw new RefRedemptionError('not_found', 'Ref id is required.');
    if (!subjectHash) throw new RefRedemptionError('mismatch', 'Subject hash is required.');
    const tableName = secureViewRefsTable();
    const now = Math.floor(Date.now() / 1000);
    try {
        const result = await client.send(
            new UpdateItemCommand({
                TableName: tableName,
                Key: { ref_id: { S: refId } },
                UpdateExpression: 'SET #status = :used',
                ConditionExpression:
                    'attribute_exists(ref_id) AND #status = :unused ' +
                    'AND user_sub_hash = :sub AND purpose = :purpose ' +
                    'AND expires_at >= :now',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                    ':unused': { S: 'unused' },
                    ':used': { S: 'used' },
                    ':sub': { S: subjectHash },
                    ':purpose': { S: purpose },
                    ':now': { N: String(now) },
                },
                ReturnValues: 'ALL_NEW',
            }),
        );
        const correlationId = result.Attributes?.correlation_id?.S ?? '';
        return { correlationId };
    } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
            throw new RefRedemptionError(
                'gone',
                'Ref is missing, expired, already used, or bound to a different user/purpose.',
            );
        }
        throw err;
    }
}

function secureViewRefsTable() {
    const tableName = process.env.SECURE_VIEW_REFS_TABLE_NAME;
    if (!tableName) {
        throw new Error('SECURE_VIEW_REFS_TABLE_NAME env var not configured');
    }
    return tableName;
}
