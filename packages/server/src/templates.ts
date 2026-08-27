/**
 * HTML templates for the local OAuth callback pages.
 *
 * Three states: success / error / warning. All share a glassmorphism
 * base style and accept a `brandName` so deployments can rebrand
 * without forking the package.
 */

import { escapeHtml } from './escape.js';

const BASE_STYLES = `
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;
    background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);
    min-height:100vh;display:flex;align-items:center;justify-content:center;color:#e4e4e7}
  .container{background:rgba(255,255,255,.05);backdrop-filter:blur(10px);
    border:1px solid rgba(255,255,255,.1);border-radius:24px;padding:48px;
    max-width:480px;width:90%;text-align:center;
    box-shadow:0 25px 50px -12px rgba(0,0,0,.5);animation:fadeIn .4s ease-out}
  .icon{width:80px;height:80px;margin:0 auto 24px;border-radius:50%;
    display:flex;align-items:center;justify-content:center;font-size:40px}
  .icon-success{background:linear-gradient(135deg,#10b981,#059669);
    box-shadow:0 10px 40px -10px rgba(16,185,129,.5)}
  .icon-error{background:linear-gradient(135deg,#ef4444,#dc2626);
    box-shadow:0 10px 40px -10px rgba(239,68,68,.5)}
  .icon-warning{background:linear-gradient(135deg,#f59e0b,#d97706);
    box-shadow:0 10px 40px -10px rgba(245,158,11,.5)}
  h1{font-size:24px;font-weight:600;margin-bottom:12px;color:#fff}
  p{font-size:16px;line-height:1.6;color:#a1a1aa;margin-bottom:8px}
  .error-box{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);
    border-radius:12px;padding:16px;margin-top:20px;text-align:left}
  .error-box code{font-family:'SF Mono',Monaco,monospace;font-size:13px;
    color:#fca5a5;word-break:break-all}
  .footer{margin-top:32px;padding-top:24px;border-top:1px solid rgba(255,255,255,.1)}
  .footer p{font-size:13px;color:#71717a}
  .brand{display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:32px}
  .brand-text{font-size:14px;font-weight:600;color:#a1a1aa;letter-spacing:.5px}
  @keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
`;

/** State for which page to render. */
export type CallbackPageKind = 'success' | 'error' | 'warning';

/** Inputs for `renderCallbackPage`. */
export interface CallbackPageInput {
    kind: CallbackPageKind;
    /** Page title (also used in `<title>`). */
    title: string;
    /** Body message. Plain text; will be HTML-escaped. */
    message: string;
    /** Optional technical detail shown in a code block (error pages). */
    detail?: string;
    /** Brand label shown above the icon. Defaults to "MCP-SAVVY". */
    brandName?: string;
}

const ICONS: Record<CallbackPageKind, { className: string; glyph: string }> = {
    success: { className: 'icon-success', glyph: '&check;' },
    error: { className: 'icon-error', glyph: '&times;' },
    warning: { className: 'icon-warning', glyph: '!' },
};

/** Render one of the three callback pages. */
export function renderCallbackPage(input: CallbackPageInput): string {
    const brand = escapeHtml(input.brandName ?? 'MCP-SAVVY');
    const title = escapeHtml(input.title);
    const message = escapeHtml(input.message);
    const detailBlock = input.detail
        ? `<div class="error-box"><code>${escapeHtml(input.detail)}</code></div>`
        : '';
    const icon = ICONS[input.kind];
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Cache-Control" content="no-store">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>${BASE_STYLES}</style>
</head>
<body>
<div class="container">
  <div class="brand"><span class="brand-text">${brand}</span></div>
  <div class="icon ${icon.className}">${icon.glyph}</div>
  <h1>${title}</h1>
  <p>${message}</p>
  ${detailBlock}
  <div class="footer"><p>You can close this tab.</p></div>
</div>
</body>
</html>`;
}
