/** Currency formatting helpers shared by tools and widget handlers. */

/**
 * Format a cent amount as a localised currency string. Falls back
 * to a manual fixed-decimal + currency code when `Intl.NumberFormat`
 * doesn't recognise the currency.
 */
export function formatCurrency(cents, currency) {
    try {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
    } catch {
        return `${(cents / 100).toFixed(2)} ${currency}`;
    }
}
