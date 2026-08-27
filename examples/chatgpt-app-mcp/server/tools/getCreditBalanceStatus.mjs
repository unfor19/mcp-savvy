/**
 * `get_credit_balance_status` — the single MVP tool exposed by
 * the chatgpt-app-mcp MCP server.
 *
 * Returns the model-safe envelope `{ status, currency }` plus a
 * one-line `content` block. The actual balance never appears in
 * `structuredContent`, `content`, or any field the host LLM can
 * see; the widget iframe redeems `_meta.secure_view_ref` against
 * `/widgets/balance` to fetch + render the real number locally.
 *
 * Step 5 wired DDB lookup + audit. Step 6 (this file) adds:
 *   - `_meta.ui.resourceUri` so ChatGPT knows which widget to
 *     render (`ui://widget/balance.html`).
 *   - `_meta.secure_view_ref` (only when status is `available`):
 *     a 60-second single-use token bound to the user's subject
 *     hash + purpose `credit_balance`.
 *   - `_meta.expires_at` so the widget can show a stale-token UI.
 */

import { getCustomer } from '../dynamo.mjs';
import { hashSubject, newCorrelationId, writeAuditEvent } from '../audit.mjs';
import { mintRef } from '../secureRefs.mjs';
import { WIDGET_RESOURCE_URI } from '../widgetUri.mjs';

export const TOOL_NAME = 'get_credit_balance_status';

const ACTION_BASE = 'balance_read';
const REF_PURPOSE = 'credit_balance';

const SAFE_CONTENT_AVAILABLE = 'Your credit balance is available in the secure panel.';
const SAFE_CONTENT_UNAVAILABLE =
    'No credit balance is on file for your account; contact support if you expected one.';

export const TOOL_DEFINITION = Object.freeze({
    name: TOOL_NAME,
    title: 'Check credit balance availability',
    description:
        "Returns whether the signed-in user's credit balance is available, plus the " +
        "currency. Never returns the actual amount or account details — those are " +
        'delivered out-of-band to a sandboxed widget via `_meta.secure_view_ref`.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    // Mirror of `structuredContent`. The model reads only the public
    // shape (`status` + `currency`); sensitive amounts live in
    // `_meta.secure_view_ref` and are redeemed by the widget.
    outputSchema: {
        type: 'object',
        properties: {
            status: {
                type: 'string',
                enum: ['available', 'unavailable'],
                description: 'Whether a credit balance is on file for the signed-in user.',
            },
            currency: {
                type: 'string',
                description: 'ISO 4217 currency code (USD, EUR, …).',
            },
        },
        required: ['status', 'currency'],
        additionalProperties: false,
    },
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
    },
    _meta: {
        // MCP Apps standard surface for the render template.
        ui: { resourceUri: WIDGET_RESOURCE_URI },
        // ChatGPT compatibility alias (Apps SDK reference section _meta on tool descriptor).
        'openai/outputTemplate': WIDGET_RESOURCE_URI,
        'openai/toolInvocation/invoking': 'Checking your balance…',
        'openai/toolInvocation/invoked': 'Balance ready',
    },
});

/**
 * Run the tool. `context` carries the JWT claims and any per-request
 * dependencies. Always returns an MCP result envelope; failure modes
 * surface via `isError: true` rather than thrown errors so the
 * dispatcher's error path stays narrow.
 */
export async function getCreditBalanceStatus(context) {
    const subject = context?.subject ?? '';
    const subjectHash = subject ? hashSubject(subject) : 'anonymous';
    const correlationId = newCorrelationId();

    await writeAuditEvent({
        action: `${ACTION_BASE}_requested`,
        userSubHash: subjectHash,
        correlationId,
        status: 'started',
    });

    try {
        const row = await getCustomer(subject);
        const status = row ? 'available' : 'unavailable';
        const currency = typeof row?.currency === 'string' ? row.currency : 'USD';
        let refMeta = null;
        if (row && subject) {
            const minted = await mintRef({ subjectHash, purpose: REF_PURPOSE, correlationId });
            refMeta = { refId: minted.refId, expiresAt: minted.expiresAt };
        }
        await writeAuditEvent({
            action: `${ACTION_BASE}_completed`,
            userSubHash: subjectHash,
            correlationId,
            status,
        });
        return buildResultEnvelope(status, currency, correlationId, refMeta);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`${TOOL_NAME} failed:`, message);
        await writeAuditEvent({
            action: `${ACTION_BASE}_failed`,
            userSubHash: subjectHash,
            correlationId,
            status: 'error',
        });
        return {
            isError: true,
            content: [
                {
                    type: 'text',
                    text: 'Unable to read your credit balance status right now.',
                },
            ],
            structuredContent: { status: 'unavailable', currency: 'USD' },
            _meta: {
                'mcp-savvy.correlation-id': correlationId,
                ui: { resourceUri: WIDGET_RESOURCE_URI },
                'openai/outputTemplate': WIDGET_RESOURCE_URI,
            },
        };
    }
}

/**
 * Build the model-safe MCP result envelope. The amount, account
 * number, and card details NEVER appear here — those leave the
 * Lambda only via `/widgets/balance`.
 */
function buildResultEnvelope(status, currency, correlationId, refMeta) {
    const text = status === 'available' ? SAFE_CONTENT_AVAILABLE : SAFE_CONTENT_UNAVAILABLE;
    const meta = {
        'mcp-savvy.correlation-id': correlationId,
        ui: { resourceUri: WIDGET_RESOURCE_URI },
        'openai/outputTemplate': WIDGET_RESOURCE_URI,
    };
    if (refMeta) {
        meta.secure_view_ref = refMeta.refId;
        meta.expires_at = refMeta.expiresAt;
        meta.purpose = REF_PURPOSE;
    }
    return {
        structuredContent: { status, currency },
        content: [{ type: 'text', text }],
        _meta: meta,
    };
}
