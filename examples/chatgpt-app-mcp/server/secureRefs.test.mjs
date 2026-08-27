/**
 * Unit tests for `secureRefs.mjs` — the mint + redeem cycle that
 * underpins the widget endpoint's defense-in-depth.
 *
 * Stubs the DynamoDB client to assert:
 *   - `mintRef` writes a row with the right keys, status `unused`,
 *     `expires_at = now + 60s`, the right subject hash + purpose.
 *   - `redeemRef` issues a conditional UpdateItem that flips
 *     `unused -> used`, scoped to the right subject + purpose +
 *     unexpired ref.
 *   - `redeemRef` maps `ConditionalCheckFailedException` to a
 *     `RefRedemptionError` with reason `gone`.
 *   - The base64url shape on a freshly minted ref id.
 */

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    mintRef,
    newRefId,
    REF_TTL_SECONDS,
    RefRedemptionError,
    redeemRef,
    setClient,
} from './secureRefs.mjs';

describe('secureRefs', () => {
    const originalEnv = { ...process.env };
    let client;

    beforeEach(() => {
        process.env.SECURE_VIEW_REFS_TABLE_NAME = 'test-secure-view-refs';
        client = { send: vi.fn() };
        setClient(client);
    });

    afterEach(() => {
        setClient(null);
        process.env = { ...originalEnv };
    });

    it('newRefId returns a base64url-shaped string of expected length', () => {
        const id = newRefId();
        expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
        // 32 bytes of randomness encode to 43 chars in base64url (no padding).
        expect(id.length).toBeGreaterThanOrEqual(40);
        expect(id.length).toBeLessThanOrEqual(44);
    });

    it('mintRef writes the expected item and returns the ref envelope', async () => {
        client.send.mockResolvedValueOnce({});
        const before = Math.floor(Date.now() / 1000);
        const result = await mintRef({
            subjectHash: 'hash-1',
            purpose: 'credit_balance',
            correlationId: 'corr-1',
        });
        const after = Math.floor(Date.now() / 1000);

        expect(client.send).toHaveBeenCalledTimes(1);
        const call = client.send.mock.calls[0]?.[0];
        const item = call.input.Item;
        expect(item.ref_id.S).toBe(result.refId);
        expect(item.status.S).toBe('unused');
        expect(item.user_sub_hash.S).toBe('hash-1');
        expect(item.purpose.S).toBe('credit_balance');
        expect(item.correlation_id.S).toBe('corr-1');
        expect(call.input.ConditionExpression).toContain('attribute_not_exists');

        const expiresAt = Number(item.expires_at.N);
        expect(expiresAt).toBeGreaterThanOrEqual(before + REF_TTL_SECONDS);
        expect(expiresAt).toBeLessThanOrEqual(after + REF_TTL_SECONDS);
        expect(result.expiresAt).toBe(expiresAt);
    });

    it('mintRef rejects calls without subject hash or purpose', async () => {
        await expect(mintRef({ subjectHash: '', purpose: 'p' })).rejects.toThrow(/subjectHash/);
        await expect(mintRef({ subjectHash: 'h', purpose: '' })).rejects.toThrow(/purpose/);
    });

    it('redeemRef issues a conditional update bound to the subject + purpose', async () => {
        client.send.mockResolvedValueOnce({
            Attributes: { correlation_id: { S: 'corr-2' } },
        });
        const result = await redeemRef({
            refId: 'r-2',
            subjectHash: 'hash-2',
            purpose: 'credit_balance',
        });
        expect(result.correlationId).toBe('corr-2');

        const call = client.send.mock.calls[0]?.[0];
        expect(call.input.Key.ref_id.S).toBe('r-2');
        expect(call.input.UpdateExpression).toContain('SET #status = :used');
        expect(call.input.ConditionExpression).toContain('#status = :unused');
        expect(call.input.ConditionExpression).toContain('user_sub_hash = :sub');
        expect(call.input.ConditionExpression).toContain('purpose = :purpose');
        expect(call.input.ConditionExpression).toContain('expires_at >= :now');
        expect(call.input.ExpressionAttributeValues[':sub'].S).toBe('hash-2');
        expect(call.input.ExpressionAttributeValues[':purpose'].S).toBe('credit_balance');
    });

    it('redeemRef maps ConditionalCheckFailedException to a "gone" error', async () => {
        const err = new ConditionalCheckFailedException({
            $metadata: {},
            message: 'condition failed',
        });
        client.send.mockRejectedValueOnce(err);
        await expect(
            redeemRef({ refId: 'r-3', subjectHash: 'hash-3', purpose: 'credit_balance' }),
        ).rejects.toMatchObject({ name: 'RefRedemptionError', reason: 'gone' });
    });

    it('redeemRef rethrows unexpected errors as-is', async () => {
        client.send.mockRejectedValueOnce(new Error('network blew up'));
        await expect(
            redeemRef({ refId: 'r-4', subjectHash: 'hash-4', purpose: 'credit_balance' }),
        ).rejects.toThrow(/network blew up/);
    });

    it('redeemRef rejects empty refId without calling DDB', async () => {
        await expect(
            redeemRef({ refId: '', subjectHash: 'hash-5', purpose: 'credit_balance' }),
        ).rejects.toBeInstanceOf(RefRedemptionError);
        expect(client.send).not.toHaveBeenCalled();
    });
});
