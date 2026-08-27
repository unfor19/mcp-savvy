/**
 * Unit tests for `get_credit_balance_status`.
 *
 * Stubs the DynamoDB client used by `dynamo.mjs`, `audit.mjs`, and
 * `secureRefs.mjs` via their `setClient()` test hook so the tool's
 * full code path runs without AWS calls.
 *
 * The contract these tests guard:
 *   - Returns `available` when the customer row exists; mints a
 *     fresh secure_view_ref + sets `_meta.ui.resourceUri`.
 *   - Returns `unavailable` when no row is found; does NOT mint a
 *     ref (no widget to render).
 *   - Always emits paired audit events (requested + completed/failed).
 *   - NEVER leaks the actual balance, card last-four, or any other
 *     sensitive field into `structuredContent` or `content`. Those
 *     fields go to the widget endpoint only.
 *   - Hashes the JWT subject before writing it to the audit log.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { setClient as setAuditClient } from '../audit.mjs';
import { setClient as setDynamoClient } from '../dynamo.mjs';
import { setClient as setSecureRefsClient } from '../secureRefs.mjs';
import {
    getCreditBalanceStatus,
    TOOL_DEFINITION,
    TOOL_NAME,
} from './getCreditBalanceStatus.mjs';
import { WIDGET_RESOURCE_URI } from '../widgetUri.mjs';

describe('get_credit_balance_status', () => {
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
        secureRefsStub = { send: vi.fn().mockResolvedValue({}) };
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

    it('publishes the expected tool definition shape', () => {
        expect(TOOL_NAME).toBe('get_credit_balance_status');
        expect(TOOL_DEFINITION.name).toBe(TOOL_NAME);
        expect(TOOL_DEFINITION.annotations.readOnlyHint).toBe(true);
        expect(TOOL_DEFINITION.inputSchema.type).toBe('object');
        expect(Object.keys(TOOL_DEFINITION.inputSchema.properties ?? {})).toEqual([]);
        expect(TOOL_DEFINITION._meta?.ui?.resourceUri).toBe(WIDGET_RESOURCE_URI);
    });

    it('returns "available" + mints a secure_view_ref when a customer row exists', async () => {
        dynamoStub.send.mockResolvedValueOnce({
            Item: {
                user_sub: { S: 'sub-1' },
                currency: { S: 'EUR' },
                balance_cents: { N: '5000000' },
                card_last_four_masked: { S: '**** **** **** 7777' },
            },
        });
        const result = await getCreditBalanceStatus({ subject: 'sub-1' });
        expect(result.structuredContent).toEqual({ status: 'available', currency: 'EUR' });
        expect(result.content[0].text).toMatch(/secure panel/i);
        expect(result.isError).toBeFalsy();
        expect(result._meta.ui.resourceUri).toBe(WIDGET_RESOURCE_URI);
        expect(typeof result._meta.secure_view_ref).toBe('string');
        expect(result._meta.secure_view_ref).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(typeof result._meta.expires_at).toBe('number');
        expect(result._meta.purpose).toBe('credit_balance');
        // mintRef should have been called exactly once on the secure-refs client.
        expect(secureRefsStub.send).toHaveBeenCalledTimes(1);
    });

    it('returns "unavailable" without minting a ref when no row is found', async () => {
        dynamoStub.send.mockResolvedValueOnce({ Item: undefined });
        const result = await getCreditBalanceStatus({ subject: 'sub-2' });
        expect(result.structuredContent).toEqual({ status: 'unavailable', currency: 'USD' });
        expect(result.content[0].text).toMatch(/no credit balance/i);
        expect(result._meta.secure_view_ref).toBeUndefined();
        expect(result._meta.expires_at).toBeUndefined();
        expect(result._meta.ui.resourceUri).toBe(WIDGET_RESOURCE_URI);
        expect(secureRefsStub.send).not.toHaveBeenCalled();
    });

    it('writes paired requested+completed audit events', async () => {
        dynamoStub.send.mockResolvedValueOnce({
            Item: { user_sub: { S: 'sub-3' }, currency: { S: 'USD' } },
        });
        await getCreditBalanceStatus({ subject: 'sub-3' });
        expect(auditCalls).toHaveLength(2);
        const [requested, completed] = auditCalls;
        expect(requested.Item.action.S).toBe('balance_read_requested');
        expect(completed.Item.action.S).toBe('balance_read_completed');
        expect(requested.Item.correlation_id.S).toBe(completed.Item.correlation_id.S);
        expect(requested.Item.user_sub_hash.S).toBe(completed.Item.user_sub_hash.S);
    });

    it('hashes the subject (sha256 hex) before writing to the audit log', async () => {
        dynamoStub.send.mockResolvedValueOnce({ Item: undefined });
        await getCreditBalanceStatus({ subject: 'plain-text-subject' });
        const sub = auditCalls[0]?.Item.user_sub_hash.S;
        expect(sub).toMatch(/^[0-9a-f]{64}$/);
        expect(sub).not.toContain('plain-text-subject');
    });

    it('writes a *_failed audit event on DDB error and returns isError', async () => {
        dynamoStub.send.mockRejectedValueOnce(new Error('boom'));
        const result = await getCreditBalanceStatus({ subject: 'sub-4' });
        expect(result.isError).toBe(true);
        expect(auditCalls.map((c) => c.Item.action.S)).toEqual([
            'balance_read_requested',
            'balance_read_failed',
        ]);
        expect(result._meta.ui.resourceUri).toBe(WIDGET_RESOURCE_URI);
        expect(result._meta.secure_view_ref).toBeUndefined();
    });

    it('never leaks balance / card / customer-id fields into the response', async () => {
        dynamoStub.send.mockResolvedValueOnce({
            Item: {
                user_sub: { S: 'sub-5' },
                currency: { S: 'USD' },
                balance_cents: { N: '1234055' },
                available_credit_cents: { N: '800000' },
                card_last_four_masked: { S: '**** **** **** 4321' },
                customer_id_hash: { S: 'fx-secret' },
            },
        });
        const result = await getCreditBalanceStatus({ subject: 'sub-5' });
        // structuredContent + content are the only fields the host
        // LLM ever sees. _meta goes to the widget iframe only.
        const serialized = JSON.stringify({
            structuredContent: result.structuredContent,
            content: result.content,
        });
        expect(serialized).not.toContain('1234055');
        expect(serialized).not.toContain('800000');
        expect(serialized).not.toContain('4321');
        expect(serialized).not.toContain('fx-secret');
        expect(serialized).not.toContain('balance_cents');
        expect(serialized).not.toContain('card_last_four');
        expect(serialized).not.toContain('customer_id');
    });
});
