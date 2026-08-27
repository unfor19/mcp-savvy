/**
 * Unit tests for `get_credit_balance_actual` — the widget-only tool.
 *
 * The contract these tests guard:
 *   - Tool descriptor is app-only (`_meta.ui.visibility=['app']` +
 *     `openai/widgetAccessible: true`).
 *   - Balance fields appear in `_meta` ONLY; `structuredContent` and
 *     `content` carry no sensitive value.
 *   - Audit events fire on every code path (started + completed/failed).
 *   - Missing ref returns a soft-error envelope without invoking redeem.
 *   - Expired/used ref returns a soft-error envelope with
 *     `_meta.error_kind === 'expired'`.
 *   - Missing customer row returns a soft-error envelope after a successful redeem.
 */

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClient as setAuditClient } from '../audit.mjs';
import { setClient as setDynamoClient } from '../dynamo.mjs';
import { setClient as setSecureRefsClient } from '../secureRefs.mjs';
import {
    getCreditBalanceActual,
    TOOL_DEFINITION,
    TOOL_NAME,
} from './getCreditBalanceActual.mjs';

describe('get_credit_balance_actual', () => {
    const originalEnv = { ...process.env };
    const auditCalls = [];
    let dynamoStub;
    let secureRefsStub;

    beforeEach(() => {
        process.env.CUSTOMER_DATA_TABLE_NAME = 'test-customer-data';
        process.env.AUDIT_LOG_TABLE_NAME = 'test-audit-log';
        process.env.SECURE_VIEW_REFS_TABLE_NAME = 'test-secure-view-refs';
        auditCalls.length = 0;
        dynamoStub = { send: vi.fn() };
        secureRefsStub = { send: vi.fn() };
        const auditStub = {
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

    it('descriptor declares app-only visibility', () => {
        expect(TOOL_NAME).toBe('get_credit_balance_actual');
        expect(TOOL_DEFINITION._meta.ui.visibility).toEqual(['app']);
        expect(TOOL_DEFINITION._meta['openai/widgetAccessible']).toBe(true);
        expect(TOOL_DEFINITION._meta['openai/visibility']).toBe('private');
        expect(TOOL_DEFINITION.annotations.readOnlyHint).toBe(true);
        expect(TOOL_DEFINITION.inputSchema.required).toEqual(['secure_view_ref']);
    });

    it('returns soft-error envelope without redeeming when secure_view_ref is missing', async () => {
        const result = await getCreditBalanceActual({}, { subject: 'sub-1' });
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toEqual({ ok: false });
        expect(result._meta.error_kind).toBe('unavailable');
        expect(secureRefsStub.send).not.toHaveBeenCalled();
        expect(auditCalls.map((c) => c.Item.action.S)).toEqual([
            'balance_widget_read_requested',
            'balance_widget_read_failed',
        ]);
    });

    it('returns soft-error envelope with error_kind=expired when redemption fails', async () => {
        secureRefsStub.send.mockRejectedValueOnce(
            new ConditionalCheckFailedException({ $metadata: {}, message: 'cond' }),
        );
        const result = await getCreditBalanceActual(
            { secure_view_ref: 'r-1' },
            { subject: 'sub-2' },
        );
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toEqual({ ok: false });
        expect(result._meta.error_kind).toBe('expired');
        // Customer lookup must NOT have been attempted.
        expect(dynamoStub.send).not.toHaveBeenCalled();
    });

    it('returns soft-error envelope when customer row is missing', async () => {
        secureRefsStub.send.mockResolvedValueOnce({
            Attributes: { correlation_id: { S: 'c-3' } },
        });
        dynamoStub.send.mockResolvedValueOnce({ Item: undefined });
        const result = await getCreditBalanceActual(
            { secure_view_ref: 'r-3' },
            { subject: 'sub-3' },
        );
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toEqual({ ok: false });
        expect(auditCalls.map((c) => c.Item.action.S)).toEqual([
            'balance_widget_read_requested',
            'balance_widget_read_failed',
        ]);
    });

    it('happy path: balance lives in _meta only; structuredContent + content have no leakage', async () => {
        secureRefsStub.send.mockResolvedValueOnce({
            Attributes: { correlation_id: { S: 'c-4' } },
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
        const result = await getCreditBalanceActual(
            { secure_view_ref: 'r-4' },
            { subject: 'sub-4' },
        );

        // _meta carries the actual balance.
        expect(result._meta.balance_cents).toBe(1234055);
        expect(result._meta.balance).toBe(12340.55);
        expect(result._meta.currency).toBe('USD');
        expect(result._meta.card_last_four_masked).toBe('**** **** **** 4321');
        expect(typeof result._meta.formatted).toBe('string');
        expect(result._meta.formatted).toMatch(/12,?340/);

        // structuredContent + content are model-visible — assert no leakage.
        const serialized = JSON.stringify({
            structuredContent: result.structuredContent,
            content: result.content,
        });
        expect(serialized).not.toContain('1234055');
        expect(serialized).not.toContain('12340');
        expect(serialized).not.toContain('4321');
        expect(serialized).not.toContain('balance_cents');
        expect(serialized).not.toContain('card_last_four');
        expect(result.structuredContent).toEqual({ ok: true });

        expect(auditCalls.map((c) => c.Item.action.S)).toEqual([
            'balance_widget_read_requested',
            'balance_widget_read_completed',
        ]);
    });
});
