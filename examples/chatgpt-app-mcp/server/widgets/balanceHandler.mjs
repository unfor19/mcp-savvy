/**
 * `POST /widgets/balance` — the only path that returns the actual
 * credit balance, and only to a sandboxed widget iframe.
 *
 * Auth surface:
 *   - Bearer JWT — same validation as `/mcp` (issuer + audience +
 *     exp + scopes). The widget's runtime injects the token (the
 *     OpenAI Apps SDK forwards the connector's session credentials
 *     automatically when the iframe makes a fetch call).
 *   - `secure_view_ref` body field — single-use, 60s TTL, bound to
 *     the JWT subject hash + purpose `credit_balance`. See
 *     `secureRefs.mjs`. Second redeem returns 410 Gone.
 *
 * Response is the widget-only shape — `balance_cents`,
 * `card_last_four_masked`, `formatted`. The server requires the
 * authenticated, single-use reference; compatible hosts separately
 * enforce model/widget presentation isolation.
 */

import { getCustomer } from '../dynamo.mjs';
import { hashSubject, newCorrelationId, writeAuditEvent } from '../audit.mjs';
import { redeemRef, RefRedemptionError } from '../secureRefs.mjs';
import { formatCurrency } from '../format.mjs';

const PURPOSE = 'credit_balance';
const ACTION_BASE = 'balance_widget_read';

/**
 * Handle a `/widgets/balance` request. Returns an HTTP-shaped
 * response: `{ statusCode, body }`. The caller layers in secure
 * headers + JSON content-type.
 */
export async function handleBalanceWidget({ body, claims }) {
    const subjectHash = claims?.sub ? hashSubject(claims.sub) : '';
    const correlationId = newCorrelationId();
    const refId = typeof body?.secure_view_ref === 'string' ? body.secure_view_ref : '';

    if (!refId) {
        return { statusCode: 400, body: { error: 'missing_ref', message: 'secure_view_ref is required.' } };
    }

    await writeAuditEvent({
        action: `${ACTION_BASE}_requested`,
        userSubHash: subjectHash,
        correlationId,
        status: 'started',
    });

    try {
        await redeemRef({ refId, subjectHash, purpose: PURPOSE });
    } catch (err) {
        if (err instanceof RefRedemptionError) {
            await writeAuditEvent({
                action: `${ACTION_BASE}_failed`,
                userSubHash: subjectHash,
                correlationId,
                status: err.reason,
            });
            const status = err.reason === 'not_found' ? 400 : 410;
            return {
                statusCode: status,
                body: { error: err.reason, message: 'Ref is no longer valid.' },
            };
        }
        throw err;
    }

    const customer = await getCustomer(claims?.sub ?? '');
    if (!customer) {
        await writeAuditEvent({
            action: `${ACTION_BASE}_failed`,
            userSubHash: subjectHash,
            correlationId,
            status: 'no_customer_row',
        });
        return {
            statusCode: 404,
            body: { error: 'no_balance', message: 'No balance is on file for your account.' },
        };
    }

    await writeAuditEvent({
        action: `${ACTION_BASE}_completed`,
        userSubHash: subjectHash,
        correlationId,
        status: 'served',
    });
    return { statusCode: 200, body: buildWidgetBody(customer) };
}

/** Render the customer row into the widget-only response body. */
function buildWidgetBody(customer) {
    const balanceCents =
        typeof customer.balance_cents === 'number' ? customer.balance_cents : 0;
    const currency = typeof customer.currency === 'string' ? customer.currency : 'USD';
    return {
        balance: balanceCents / 100,
        balance_cents: balanceCents,
        currency,
        formatted: formatCurrency(balanceCents, currency),
        card_last_four_masked:
            typeof customer.card_last_four_masked === 'string'
                ? customer.card_last_four_masked
                : '',
        as_of: typeof customer.last_updated === 'string' ? customer.last_updated : '',
    };
}
