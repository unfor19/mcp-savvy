/**
 * Content-hashed URIs and assembled bundles for every widget the
 * Lambda serves.
 *
 * Why hashing: ChatGPT (and other Apps SDK hosts) cache widget HTML
 * by URI. With a static URI like `ui://widget/balance.html` the
 * host keeps serving the cached body forever. We hash each widget
 * bundle (HTML + CSS + JS) at Lambda module load and embed the
 * hash into the URI segment, so any deploy that changes a widget
 * produces a new URI and the host transparently re-fetches.
 *
 * The exported `WIDGETS` map is the single source of truth: name,
 * version, URI, lenient-match prefix, and the assembled HTML body.
 * `mcp.mjs` reads off this map for `resources/list` + `resources/read`;
 * tools reference it for `_meta.ui.resourceUri`.
 *
 * Backward-compat balance-only exports remain so existing tools
 * keep working without source churn.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIDGET_DIR = path.join(HERE, 'widget');

/**
 * Read a widget's HTML/CSS/JS, assemble them into the served body,
 * and content-hash the trio for cache-busting. The host iframe is
 * sandboxed and can't fetch relative `<link>` / `<script src>`, so
 * the bundled HTML inlines CSS + JS.
 */
function loadWidget(name, commonJs) {
    const html = readFileSync(path.join(WIDGET_DIR, `${name}.html`), 'utf8');
    const css = readFileSync(path.join(WIDGET_DIR, `${name}.css`), 'utf8');
    const widgetJs = readFileSync(path.join(WIDGET_DIR, `${name}.js`), 'utf8');
    // Prepend `common.js` to every widget bundle: the shared helpers
    // (`applyTheme`, `escapeHtml`, `awaitToolResult`) live in an IIFE
    // there and expose themselves via `window.__savvyWidget` so each
    // widget can use them without redeclaring top-level symbols.
    const js = commonJs + '\n' + widgetJs;
    const version = createHash('sha256').update(html + css + js).digest('hex').slice(0, 8);
    return Object.freeze({
        name,
        version,
        uri: `ui://widget/${name}.${version}.html`,
        prefix: `ui://widget/${name}.`,
        bundle: html.replace('__CSS__', () => css).replace('__JS__', () => js),
    });
}

const COMMON_JS = readFileSync(path.join(WIDGET_DIR, 'common.js'), 'utf8');

/** Map of widget name → metadata + assembled HTML. Add new widgets here. */
export const WIDGETS = Object.freeze({
    balance: loadWidget('balance', COMMON_JS),
    branches: loadWidget('branches', COMMON_JS),
});

/**
 * Find the widget whose prefix matches a given URI. Lenient prefix
 * match: any URI starting with a known widget's prefix maps to the
 * current bundle, so old chats with stale content-hashed URIs
 * still resolve when the user replays them. Returns `null` when
 * no widget matches.
 */
export function lookupWidget(uri) {
    if (typeof uri !== 'string') return null;
    for (const w of Object.values(WIDGETS)) if (uri.startsWith(w.prefix)) return w;
    return null;
}

// Backward-compat aliases — existing balance-tool code imports these
// names. Aliasing avoids a churny rename across the test + tool files.
export const WIDGET_VERSION = WIDGETS.balance.version;
export const WIDGET_RESOURCE_URI = WIDGETS.balance.uri;
export const WIDGET_RESOURCE_URI_PREFIX = WIDGETS.balance.prefix;
