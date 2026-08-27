/**
 * Minimal HTML escaper for values interpolated into the callback
 * pages. We never trust IdP-supplied strings (`error`,
 * `error_description`) — they may contain `<script>` payloads.
 */

const ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

/** HTML-escape `&`, `<`, `>`, `"`, `'`. */
export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}
