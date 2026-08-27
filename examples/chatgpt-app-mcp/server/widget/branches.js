/*
 * mcp-savvy chatgpt-app-mcp branches list widget runtime.
 *
 * Reads the tool's `structuredContent` (delivered to the iframe by
 * the host) and renders a list of branches with today's open/closed
 * status. Non-sensitive data — no secure_view_ref ceremony.
 *
 * Cross-host:
 *   - ChatGPT:   `window.openai.toolOutput` (eager) or
 *                `window.openai.toolResponseMetadata.mcp_tool_result.structuredContent`.
 *   - MCP Apps:  await `ui/notifications/tool-result` postMessage,
 *                read `params.structuredContent`.
 *   - Local dev: empty state.
 *
 * Theme + escape + tool-result listener helpers live in `common.js`
 * (prepended to this bundle) and are accessed via
 * `window.__savvyWidget`.
 */

(() => {
    const els = {
        card: document.getElementById('card'),
        title: document.getElementById('title'),
        list: document.getElementById('list'),
        badgeText: document.getElementById('badgeText'),
        footerText: document.getElementById('footerText'),
    };
    const helpers = window.__savvyWidget;

    function renderEmpty(message) {
        els.card.dataset.state = 'empty';
        els.list.innerHTML = '';
        els.badgeText.textContent = '0';
        els.footerText.textContent = message || 'No branches to show.';
    }

    function rowHtml(b) {
        const state = b.today && b.today.isOpen ? 'open' : 'closed';
        const statusLabel = b.today && b.today.isOpen
            ? 'Open · until ' + helpers.escapeHtml(b.today.closesAt || '')
            : (b.today && b.today.opensAt
                ? 'Closed · opens ' + helpers.escapeHtml(b.today.opensAt)
                : 'Closed today');
        // Prefer the server-supplied directions URL (find_nearest_branches
        // builds it from the address text). The origin is omitted so
        // Google Maps uses the user's actual device location ("Your
        // Location") resolved at click time — reliable across web +
        // mobile and avoids stale coarse coords from `_meta`.
        const fallbackDest = b.address
            ? (b.region ? b.address + ', ' + b.region : b.address)
            : (typeof b.lat === 'number' && typeof b.lon === 'number')
                ? b.lat + ',' + b.lon
                : '';
        const directionsHref = (typeof b.directionsUrl === 'string' && b.directionsUrl)
            ? b.directionsUrl
            : (fallbackDest
                ? 'https://www.google.com/maps/dir/?api=1&destination='
                + encodeURIComponent(fallbackDest)
                + '&travelmode=driving'
                : '');
        const directions = directionsHref
            ? '<a class="dir" href="' + helpers.escapeHtml(directionsHref) + '" target="_blank" rel="noopener noreferrer">Directions →</a>'
            : '';
        const distance = (typeof b.distanceKm === 'number' && Number.isFinite(b.distanceKm))
            ? '<span class="dist">' + formatDistance(b.distanceKm) + '</span>'
            : '';
        return ''
            + '<li class="row ' + state + '">'
            + '<div class="meta">'
            + '<span class="name">' + helpers.escapeHtml(b.name || b.branch_id || '') + '</span>'
            + '<span class="address">' + helpers.escapeHtml(b.address || '') + '</span>'
            + '</div>'
            + '<div class="right">'
            + '<span class="status">' + statusLabel + '</span>'
            + distance
            + directions
            + '</div>'
            + '</li>';
    }

    /** Format a distance in km — sub-1km shows meters, otherwise rounded km. */
    function formatDistance(km) {
        if (km < 1) return Math.round(km * 1000) + ' m';
        if (km < 10) return km.toFixed(1) + ' km';
        return Math.round(km) + ' km';
    }

    function renderBranchList(data) {
        if (!data || !Array.isArray(data.branches) || data.branches.length === 0) {
            renderEmpty(data && data.cityFilter
                ? 'No Savvy branches in ' + data.cityFilter + '.'
                : 'No branches found.');
            return;
        }
        els.card.dataset.state = 'ok';
        const openCount = data.branches.filter((b) => b.today && b.today.isOpen).length;
        els.badgeText.textContent = openCount + ' open / ' + data.branches.length;
        if (data.cityFilter) els.title.textContent = 'Savvy branches · ' + data.cityFilter;
        els.list.innerHTML = data.branches.map(rowHtml).join('');
        els.footerText.textContent = data.totalCount
            ? data.branches.length + ' shown · ' + data.totalCount + ' total'
            : data.branches.length + ' shown';
    }

    /**
     * Try to read structuredContent from `window.openai` (ChatGPT's
     * eager compatibility layer). Returns null if it isn't populated yet.
     */
    function tryEagerRead() {
        const w = window.openai;
        if (!w) return null;
        if (w.toolOutput && typeof w.toolOutput === 'object') return w.toolOutput;
        const sc = w.toolResponseMetadata
            && w.toolResponseMetadata.mcp_tool_result
            && w.toolResponseMetadata.mcp_tool_result.structuredContent;
        return sc || null;
    }

    let rendered = false;
    function update(data) {
        if (!data) return;
        rendered = true;
        renderBranchList(data);
    }

    // 1. Try the eager path immediately on mount.
    const eager = tryEagerRead();
    if (eager) update(eager);

    // 2. Subscribe permanently to `ui/notifications/tool-result`.
    //    ChatGPT often delivers tool results AFTER the iframe mounts —
    //    especially when the model "thinks" for several seconds. The
    //    one-shot `awaitToolResult(2_000)` we used previously gave up
    //    too early on slower turns.
    window.addEventListener('message', function (event) {
        if (event.source !== window.parent) return;
        const msg = event.data;
        if (!msg || msg.jsonrpc !== '2.0') return;
        if (msg.method !== 'ui/notifications/tool-result') return;
        const sc = msg.params && msg.params.structuredContent;
        if (sc) update(sc);
    }, { passive: true });

    // 3. React to `window.openai` global updates from the host.
    window.addEventListener('openai:set_globals', function () {
        const sc = tryEagerRead();
        if (sc) update(sc);
    }, { passive: true });

    // 4. Show the unavailable state only when we genuinely got nothing
    //    after a generous window. ChatGPT's "Thought for X seconds"
    //    can stretch to ~30s on cold starts or complex prompts; if
    //    the tool result truly never arrives, the user will re-prompt
    //    on their own, so a long-but-finite timeout is the right
    //    trade-off vs an infinite skeleton.
    setTimeout(function () {
        if (!rendered) {
            renderEmpty('Branch data unavailable. Re-send the prompt.');
        }
    }, 45_000);
})();
