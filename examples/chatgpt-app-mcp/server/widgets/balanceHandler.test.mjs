/**
 * Unit tests for `/widgets/balance`.
 *
 * Stubs the DDB client used by `dynamo`, `audit`, and `secureRefs`
 * to assert:
 *   - 400 when the ref is missing from the body.
 *   - 410 when redemption fails (used / expired / wrong subject).
 *   - 200 with the widget-only payload when redemption + lookup
 *     succeed; payload contains balance + card-last-four (this
 *     endpoint is the SOLE path that's allowed to return them).
 *   - Audit events fire on every code path (started + completed/failed).
 */

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClient as setAuditClient } from '../audit.mjs';
import { setClient as setDynamoClient } from '../dynamo.mjs';
import { setClient as setSecureRefsClient } from '../secureRefs.mjs';
import { handleBalanceWidget } from './balanceHandler.mjs';

describe('handleBalanceWidget', () => {
    const originalEnv = { ...process.env };
    let dynamoStub;
    let auditStub;
    let secureRefsStub;
    const auditCalls = [];

    beforeEach(() => {
        process.env.CUSTOMER_DATA_TABLE_NAME = 'test-customer-data';
        process.env.AUDIT_LOG_TABLE_NAME = 'test-audit-log';
        process.env.SECURE_VIEW_REFS_TABLE_NAME = 'test-secure-view-refs';
        auditCalls.length = 0;
        dynamoStub = { send: vi.fn() };
        secureRefsStub = { send: vi.fn() };
        auditStub = {
            send: vi.fn(async (cmd) => {
                auditCalls.push(cmd?.input ?? cmd);
                return {};
            }),
        };
        setDynamoClient(dynamoStub);
        setAuditClient(auditStub);
        setSecureRefsClient(secureRefsStub);
    });

    afterEach(() => {
        setDynamoClient(null);
        setAuditClient(null);
        setSecureRefsClient(null);
        process.env = { ...originalEnv };
    });

    it('returns 400 when secure_view_ref is missing', async () => {
        const result = await handleBalanceWidget({
            body: {},
            claims: { sub: 'sub-1' },
        });
        expect(result.statusCode).toBe(400);
        expect(result.body.error).toBe('missing_ref');
        expect(auditCalls).toHaveLength(0);
    });

    it('returns 410 when the ref is gone (used / expired / mismatched)', async () => {
        secureRefsStub.send.mockRejectedValueOnce(
            new ConditionalCheckFailedException({ $metadata: {}, message: 'fail' }),
        );
        const result = await handleBalanceWidget({
            body: { secure_view_ref: 'r-1' },
            claims: { sub: 'sub-2' },
        });
        expect(result.statusCode).toBe(410);
        expect(result.body.error).toBe('gone');
        expect(auditCalls.map((c) => c.Item.action.S)).toEqual([
            'balance_widget_read_requested',
            'balance_widget_read_failed',
        ]);
        expect(auditCalls[1].Item.status.S).toBe('gone');
    });

    it('returns 404 when the ref redeems but no customer row exists', async () => {
        secureRefsStub.send.mockResolvedValueOnce({
            Attributes: { correlation_id: { S: 'corr-3' } },
        });
        dynamoStub.send.mockResolvedValueOnce({ Item: undefined });
        const result = await handleBalanceWidget({
            body: { secure_view_ref: 'r-3' },
            claims: { sub: 'sub-3' },
        });
        expect(result.statusCode).toBe(404);
        expect(result.body.error).toBe('no_balance');
        expect(auditCalls.map((c) => c.Item.action.S)).toEqual([
            'balance_widget_read_requested',
            'balance_widget_read_failed',
        ]);
    });

    it('returns 200 + the widget-only payload on the happy path', async () => {
        secureRefsStub.send.mockResolvedValueOnce({
            Attributes: { correlation_id: { S: 'corr-4' } },
        });
        dynamoStub.send.mockResolvedValueOnce({
            Item: {
                user_sub: { S: 'sub-4' },
                currency: { S: 'USD' },
                balance_cents: { N: '1234055' },
                card_last_four_masked: { S: '**** **** **** 4321' },
                last_updated: { S: '2026-06-01T00:00:00Z' },
            },
        });
        const result = await handleBalanceWidget({
            body: { secure_view_ref: 'r-4' },
            claims: { sub: 'sub-4' },
        });
        expect(result.statusCode).toBe(200);
        expect(result.body).toMatchObject({
            balance: 12340.55,
            balance_cents: 1234055,
            currency: 'USD',
            card_last_four_masked: '**** **** **** 4321',
            as_of: '2026-06-01T00:00:00Z',
        });
        expect(typeof result.body.formatted).toBe('string');
        expect(result.body.formatted).toMatch(/12,?340/);
        expect(auditCalls.map((c) => c.Item.action.S)).toEqual([
            'balance_widget_read_requested',
            'balance_widget_read_completed',
        ]);
    });
});
