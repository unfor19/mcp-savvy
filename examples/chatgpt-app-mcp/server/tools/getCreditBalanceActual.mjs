/**
 * `get_credit_balance_actual` — the WIDGET-ONLY tool that returns
 * the real balance.
 *
 * Visibility is `["app"]`; compatible hosts keep this tool and its
 * result outside model context. The widget calls
 * it via `window.openai.callTool('get_credit_balance_actual', { ... })`
 * and reads the answer from the result's `_meta`. By spec, `_meta`
 * is delivered to the component only and hidden from the model
 * transcript (Apps SDK reference: tool result `_meta` is "Delivered
 * only to the component. Hidden from the model.").
 *
 * Defense in depth on top of visibility:
 *   - JWT validation runs at the `/mcp` boundary before this tool
 *     is dispatched (issuer + audience + exp + `balance.read` scope).
 *   - The `secure_view_ref` argument is single-use, 60s TTL, bound
 *     to the JWT subject hash + purpose `credit_balance`. Replaying
 *     an already-redeemed ref returns an isError envelope.
 *   - We deliberately put NOTHING sensitive in `structuredContent`
 *     or `content`; the only field the model could ever see is the
 *     hardcoded "balance ready" sentence.
 */

import { getCustomer } from '../dynamo.mjs';
import { hashSubject, newCorrelationId, writeAuditEvent } from '../audit.mjs';
import { redeemRef, RefRedemptionError } from '../secureRefs.mjs';
import { formatCurrency } from '../format.mjs';

export const TOOL_NAME = 'get_credit_balance_actual';

const ACTION_BASE = 'balance_widget_read';
const PURPOSE = 'credit_balance';

export const TOOL_DEFINITION = Object.freeze({
    name: TOOL_NAME,
    title: 'Read credit balance for widget',
    description:
        'Widget-only tool. Redeems a single-use secure_view_ref and returns the actual ' +
        'credit balance in app-only tool result `_meta`. Compatible hosts isolate it. ' +
        'calls this via `window.openai.callTool`.',
    inputSchema: {
        type: 'object',
        properties: {
            secure_view_ref: {
                type: 'string',
                description:
                    'Base64url ref minted by `get_credit_balance_status`. Single-use, ' +
                    '60-second TTL.',
            },
        },
        required: ['secure_view_ref'],
        additionalProperties: false,
    },
    // Mirror of `structuredContent`. The model-visible payload is a
    // single boolean confirmation; the actual balance lives in `_meta`
    // and is delivered to the widget only.
    outputSchema: {
        type: 'object',
        properties: {
            ok: {
                type: 'boolean',
                description:
                    'True when the secure_view_ref was redeemed and the balance was delivered to the widget.',
            },
        },
        required: ['ok'],
        additionalProperties: false,
    },
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
    },
    _meta: {
        // MCP Apps standard: limit visibility to the widget ("app").
        // Compatible hosts keep this app-only tool out of model-visible listings.
        ui: { visibility: ['app'] },
        // ChatGPT compatibility aliases for the same intent.
        'openai/widgetAccessible': true,
        'openai/visibility': 'private',
        'openai/toolInvocation/invoking': 'Loading balance…',
        'openai/toolInvocation/invoked': 'Balance ready',
    },
});

/**
 * Run the tool. `context.subject` is the JWT subject claim; the
 * dispatcher passes it through. Returns an MCP result envelope.
 * The actual balance lives in `_meta` exclusively — nothing
 * sensitive ever lands in `structuredContent` or `content`.
 */
export async function getCreditBalanceActual(args, context) {
    const subject = context?.subject ?? '';
    const subjectHash = subject ? hashSubject(subject) : 'anonymous';
    const refId = typeof args?.secure_view_ref === 'string' ? args.secure_view_ref : '';
    const correlationId = newCorrelationId();

    await writeAuditEvent({
        action: `${ACTION_BASE}_requested`,
        userSubHash: subjectHash,
        correlationId,
        status: 'started',
    });

    if (!refId) {
        await writeAuditEvent({
            action: `${ACTION_BASE}_failed`,
            userSubHash: subjectHash,
            correlationId,
            status: 'missing_ref',
        });
        return errorEnvelope('Missing secure_view_ref.', correlationId);
    }

    try {
        await redeemRef({ refId, subjectHash, purpose: PURPOSE });
    } catch (err) {
        const reason = err instanceof RefRedemptionError ? err.reason : 'error';
        await writeAuditEvent({
            action: `${ACTION_BASE}_failed`,
            userSubHash: subjectHash,
            correlationId,
            status: reason,
        });
        if (err instanceof RefRedemptionError) {
            return errorEnvelope(
                'Secure session expired or already used.',
                correlationId,
                'expired',
            );
        }
        throw err;
    }

    const customer = await getCustomer(subject);
    if (!customer) {
        await writeAuditEvent({
            action: `${ACTION_BASE}_failed`,
            userSubHash: subjectHash,
            correlationId,
            status: 'no_customer_row',
        });
        return errorEnvelope('No balance is on file for your account.', correlationId);
    }

    await writeAuditEvent({
        action: `${ACTION_BASE}_completed`,
        userSubHash: subjectHash,
        correlationId,
        status: 'served',
    });
    return buildSuccessEnvelope(customer, correlationId);
}

/** Build the model-safe success envelope; the balance lives in `_meta`. */
function buildSuccessEnvelope(customer, correlationId) {
    const balanceCents =
        typeof customer.balance_cents === 'number' ? customer.balance_cents : 0;
    const currency = typeof customer.currency === 'string' ? customer.currency : 'USD';
    return {
        // Model-visible: a stable confirmation only. NEVER the amount.
        structuredContent: { ok: true },
        content: [{ type: 'text', text: 'Balance delivered to the secure widget.' }],
        // Widget-only payload. Apps SDK forwards `_meta` to the iframe
        // exclusively; it never enters the model transcript.
        _meta: {
            'mcp-savvy.correlation-id': correlationId,
            balance_cents: balanceCents,
            balance: balanceCents / 100,
            currency,
            formatted: formatCurrency(balanceCents, currency),
            card_last_four_masked:
                typeof customer.card_last_four_masked === 'string'
                    ? customer.card_last_four_masked
                    : '',
            as_of: typeof customer.last_updated === 'string' ? customer.last_updated : '',
        },
    };
}

/**
 * Build a non-error envelope that signals failure via `_meta.error_kind`.
 * We deliberately omit `isError: true` here — ChatGPT's host wraps
 * isError results as a `RuntimeException` and surfaces them in the
 * widget UI as raw error text, which is ugly and confusing on
 * stale chat replays. The widget reads `_meta.error_kind` and
 * renders the appropriate state (expired vs unavailable). The
 * model still sees `structuredContent: { ok: false }` so it can
 * react if it ever calls this tool directly.
 */
function errorEnvelope(safeMessage, correlationId, kind = 'unavailable') {
    return {
        structuredContent: { ok: false },
        content: [{ type: 'text', text: 'The widget can show details when you re-run the prompt.' }],
        _meta: {
            'mcp-savvy.correlation-id': correlationId,
            error_kind: kind,
            error_message: safeMessage,
        },
    };
}
