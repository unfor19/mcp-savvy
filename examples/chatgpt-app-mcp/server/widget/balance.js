/*
 * mcp-savvy chatgpt-app-mcp credit-balance widget runtime.
 *
 * Cross-host: written to the MCP Apps standard bridge (spec
 * 2026-01-26, supported by Claude, ChatGPT, VS Code, Goose,
 * Postman, MCPJam). Falls back to ChatGPT's `window.openai.*`
 * compatibility shims when those are present, and to a direct
 * fetch + URL param when running outside any MCP host (local
 * iframe dev). All three paths converge on the same UI.
 *
 * Wire summary:
 *
 *   Initial render:
 *     - Standard:  await for `ui/notifications/tool-result`
 *                  postMessage carrying `{ structuredContent,
 *                  content, _meta }` from window.parent.
 *     - ChatGPT:   read window.openai.toolResponseMetadata (the
 *                  same envelope, exposed eagerly).
 *     - Local dev: URL param `secure_view_ref`.
 *
 *   Calling another tool:
 *     - Standard:  postMessage a JSON-RPC `tools/call` request to
 *                  window.parent; await the response on the same
 *                  message channel keyed by request id.
 *     - ChatGPT:   await window.openai.callTool(name, args).
 *     - Local dev: POST /widgets/balance directly.
 */

(() => {
    const els = {
        card: document.getElementById('card'),
        header: document.getElementById('header'),
        amount: document.getElementById('amount'),
        meta: document.getElementById('meta'),
        footer: document.getElementById('footer'),
        footerText: document.getElementById('footerText'),
        badgeText: document.getElementById('badgeText'),
    };

    function applyTheme() {
        const theme = window.openai && typeof window.openai.theme === 'string'
            ? window.openai.theme
            : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
    }
    applyTheme();
    window.addEventListener('openai:set_globals', applyTheme, { passive: true });

    function setState(state) {
        els.card.dataset.state = state;
        els.header.dataset.state = state;
        els.footer.dataset.state = state;
    }

    function renderSuccess(meta) {
        setState('ok');
        els.amount.textContent = meta.formatted ||
            (typeof meta.balance === 'number' ? meta.balance.toFixed(2) : '—');
        const parts = [];
        if (meta.card_last_four_masked) parts.push(meta.card_last_four_masked);
        if (meta.as_of) {
            const formatted = formatAsOf(meta.as_of);
            if (formatted) parts.push('As of ' + formatted);
        }
        els.meta.innerHTML = parts
            .map((p, i) => (i === 0 ? '' : '<span class="sep">•</span>') + '<span>' + escapeHtml(p) + '</span>')
            .join(' ');
        els.footerText.textContent = 'Visible only inside this widget';
        els.badgeText.textContent = 'Encrypted';
    }

    /**
     * Format an ISO timestamp as `dd-MMM-yyyy, h:mm am/pm` —
     * unambiguous for non-US locales and compact enough to live on
     * the same row as the masked card number.
     */
    function formatAsOf(iso) {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        const day = String(d.getDate()).padStart(2, '0');
        const month = d.toLocaleString('en-US', { month: 'short' });
        const year = d.getFullYear();
        const ampm = d.getHours() >= 12 ? 'PM' : 'AM';
        const hour12 = ((d.getHours() + 11) % 12) + 1;
        const minute = String(d.getMinutes()).padStart(2, '0');
        return `${day}-${month}-${year}, ${hour12}:${minute} ${ampm}`;
    }

    function renderExpired() {
        setState('expired');
        els.amount.textContent = 'Secure session ended';
        els.meta.textContent = '';
        els.footerText.textContent = 'Re-send the prompt to view your balance.';
        els.badgeText.textContent = 'Expired';
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    /**
     * JSON-RPC postMessage bridge to the host. Spec 2026-01-26 section
     * "MCP Apps UI bridge". Returns a Promise that resolves with the
     * response.result for `tools/call`, listens for one-shot
     * notifications for `ui/notifications/tool-result`.
     */
    const pending = new Map();
    let nextRpcId = 1;

    window.addEventListener('message', (event) => {
        if (event.source !== window.parent) return;
        const msg = event.data;
        if (!msg || msg.jsonrpc !== '2.0') return;
        if (msg.id !== undefined && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(Object.assign(new Error(msg.error.message ?? 'rpc error'), { code: msg.error.code }));
            else resolve(msg.result);
        }
    }, { passive: true });

    function rpcRequest(method, params) {
        return new Promise((resolve, reject) => {
            const id = `rpc-${nextRpcId++}`;
            pending.set(id, { resolve, reject });
            window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
            setTimeout(() => {
                if (pending.delete(id)) reject(new Error(`Timed out waiting for ${method}`));
            }, 30_000);
        });
    }

    function awaitToolResult(timeoutMs = 5_000) {
        return new Promise((resolve) => {
            const onMessage = (event) => {
                if (event.source !== window.parent) return;
                const msg = event.data;
                if (!msg || msg.jsonrpc !== '2.0') return;
                if (msg.method !== 'ui/notifications/tool-result') return;
                window.removeEventListener('message', onMessage);
                resolve(msg.params ?? null);
            };
            window.addEventListener('message', onMessage, { passive: true });
            setTimeout(() => {
                window.removeEventListener('message', onMessage);
                resolve(null);
            }, timeoutMs);
        });
    }

    async function readMetaFromHost() {
        // Path 1 (ChatGPT compat): the host exposes the full tool
        // result envelope on window.openai.toolResponseMetadata.
        // Per the Apps SDK reference, the shape in ChatGPT is:
        //   { status, call_tool_result, mcp_tool_result: {
        //       structuredContent, content, _meta: {...} } }
        // The hidden _meta with our `secure_view_ref` lives one
        // level deeper than the wrapper. We also tolerate a
        // historical un-wrapped shape (`_meta` properties spread on
        // the outer object) for older host versions.
        const sdkResp = (window.openai && window.openai.toolResponseMetadata) || null;
        if (sdkResp) {
            const wrapped = sdkResp.mcp_tool_result && sdkResp.mcp_tool_result._meta;
            if (wrapped && typeof wrapped.secure_view_ref === 'string') return wrapped;
            if (typeof sdkResp.secure_view_ref === 'string') return sdkResp;
        }
        // Path 2 (MCP Apps standard): the host posts the tool result
        // as a `ui/notifications/tool-result` JSON-RPC notification.
        // Wait briefly for it on mount; if the host re-posts later
        // we still catch it via this listener.
        const result = await awaitToolResult(2_000);
        if (result && result._meta && typeof result._meta.secure_view_ref === 'string') {
            return result._meta;
        }
        // Path 3 (heal around ChatGPT _meta-drop bug): when paths 1
        // and 2 BOTH yielded nothing, the host had a fresh tool
        // result but failed to forward _meta to the widget. Confirmed
        // ChatGPT bug: https://community.openai.com/t/mcp-apps-in-chatgpt-are-fundamentally-broken-2-critical-bugs/1377697
        // Mint a fresh ref ourselves via widget-initiated callTool.
        // The model never sees the widget-initiated call, the same
        // 60s TTL applies, and a fresh audit_log row is written —
        // so the compliance trail is identical. We deliberately do
        // NOT retry after a redemption FAILURE: that's the stale-
        // chat case, where the user is replaying history and should
        // re-prompt rather than silently re-fetch.
        const minted = await mintRefFromWidget();
        if (minted) return minted;
        // Path 4 (local dev): URL param.
        const params = new URLSearchParams(window.location.search);
        const ref = params.get('secure_view_ref');
        return ref ? { secure_view_ref: ref } : null;
    }

    /**
     * Recovery path: call `get_credit_balance_status` from the
     * widget itself to mint a fresh secure_view_ref. Used only when
     * the host failed to deliver _meta at all. Returns the meta of
     * the new result, or null when the call fails.
     */
    async function mintRefFromWidget() {
        if (!window.openai || typeof window.openai.callTool !== 'function') return null;
        try {
            const result = await window.openai.callTool('get_credit_balance_status', {});
            const meta =
                (result && result.mcp_tool_result && result.mcp_tool_result._meta) ||
                (result && result._meta) ||
                null;
            if (meta && typeof meta.secure_view_ref === 'string') return meta;
        } catch {
            // Swallow — caller falls through to the URL-param path
            // and ultimately the expired-state UI.
        }
        return null;
    }

    async function fetchBalance(ref) {
        const args = { secure_view_ref: ref };
        // Path 1 (ChatGPT compat): synchronous helper.
        if (window.openai && typeof window.openai.callTool === 'function') {
            const result = await window.openai.callTool('get_credit_balance_actual', args);
            return parseToolResult(result);
        }
        // Path 2 (MCP Apps standard): JSON-RPC tools/call via postMessage.
        if (window.parent && window.parent !== window) {
            try {
                const result = await rpcRequest('tools/call', {
                    name: 'get_credit_balance_actual',
                    arguments: args,
                });
                return parseToolResult(result);
            } catch (err) {
                // Fall through to direct fetch only if the host clearly
                // doesn't speak the bridge — most failures here are
                // transport problems and shouldn't silently re-route.
                if (!/method not found|unknown method/i.test(String(err.message))) throw err;
            }
        }
        // Path 3 (local dev): direct HTTP.
        const res = await fetch('/widgets/balance', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(args),
        });
        if (res.status === 410) return { kind: 'expired' };
        if (!res.ok) return { kind: 'error', message: 'HTTP ' + res.status };
        const body = await res.json();
        return { kind: 'ok', meta: body };
    }

    function parseToolResult(result) {
        // Same shape variance as readMetaFromHost: ChatGPT may wrap
        // the tool result envelope in `mcp_tool_result`. The actual
        // amount + currency lives in `_meta`.
        if (!result) return { kind: 'error', message: 'Empty widget payload.' };
        const meta =
            (result.mcp_tool_result && result.mcp_tool_result._meta) ||
            result._meta ||
            result.toolResponseMetadata;
        if (!meta) return { kind: 'error', message: 'Empty widget payload.' };
        if (meta.error_kind === 'expired') return { kind: 'expired' };
        if (meta.error_kind) return { kind: 'error', message: meta.error_message || '' };
        return { kind: 'ok', meta };
    }

    (async () => {
        const meta = await readMetaFromHost();
        if (!meta) {
            renderExpired();
            return;
        }
        try {
            const result = await fetchBalance(meta.secure_view_ref);
            if (result.kind === 'expired' || result.kind === 'error') {
                // Stale chats, single-use ref already redeemed, or
                // anything else that can't render a fresh balance:
                // tell the user to re-prompt rather than show raw
                // error text. The 60s ref TTL is by design — a
                // historical chat view should not silently fetch a
                // new balance behind the user's back.
                return renderExpired();
            }
            renderSuccess(result.meta);
        } catch {
            renderExpired();
        }
    })();
})();
