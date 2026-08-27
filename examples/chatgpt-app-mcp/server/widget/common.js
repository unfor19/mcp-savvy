/*
 * mcp-savvy chatgpt-app-mcp shared widget runtime helpers.
 *
 * Prepended to every widget's inline JS by `widgetUri.mjs`, so all
 * widgets share a single implementation of theme handling, HTML
 * escaping, and the MCP Apps `ui/notifications/tool-result` listener.
 *
 * Helpers are defined inside an IIFE so they aren't top-level
 * symbols (fon's duplicate-symbol check stays clean as more
 * widgets land). They're exposed via the read-only
 * `window.__savvyWidget` global, which is the one and only
 * top-level symbol this file introduces.
 *
 * The IIFE also installs the Apps SDK theme listener so each
 * widget gets light/dark + system-preference handling for free.
 */

(function () {
    function applyThemeImpl() {
        var theme = window.openai && typeof window.openai.theme === 'string'
            ? window.openai.theme
            : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
    }

    function escapeHtmlImpl(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
            })[c];
        });
    }

    /**
     * Resolve when the host posts a `ui/notifications/tool-result`
     * JSON-RPC notification or when `timeoutMs` elapses (returns null).
     * Used by widgets that don't get an eager `window.openai.toolOutput`
     * (e.g. non-ChatGPT MCP Apps hosts).
     */
    function awaitToolResultImpl(timeoutMs) {
        return new Promise(function (resolve) {
            function listener(event) {
                if (event.source !== window.parent) return;
                var msg = event.data;
                if (!msg || msg.jsonrpc !== '2.0') return;
                if (msg.method !== 'ui/notifications/tool-result') return;
                window.removeEventListener('message', listener);
                resolve(msg.params || null);
            }
            window.addEventListener('message', listener, { passive: true });
            setTimeout(function () {
                window.removeEventListener('message', listener);
                resolve(null);
            }, timeoutMs);
        });
    }

    window.__savvyWidget = Object.freeze({
        applyTheme: applyThemeImpl,
        escapeHtml: escapeHtmlImpl,
        awaitToolResult: awaitToolResultImpl,
    });

    // Initial theme + subscribe to host theme changes. Widgets get
    // light/dark for free without any per-widget code.
    applyThemeImpl();
    window.addEventListener('openai:set_globals', applyThemeImpl, { passive: true });
})();
