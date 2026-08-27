/**
 * Unit tests for the callback HTML templates.
 *
 * Security-critical assertions: every interpolated value (title,
 * message, detail, brand) must be HTML-escaped, and no template ever
 * carries `<script>` from raw input.
 */

import { describe, it, expect } from 'vitest';
import { renderCallbackPage } from './templates.js';

describe('renderCallbackPage', () => {
    it('renders a valid HTML doctype + lang', () => {
        const html = renderCallbackPage({
            kind: 'success',
            title: 'Signed in',
            message: 'You can close this tab.',
        });
        expect(html.startsWith('<!doctype html>')).toBe(true);
        expect(html).toMatch(/<html lang="en">/);
        expect(html).toContain('<title>Signed in</title>');
    });

    it('escapes the title against HTML injection', () => {
        const html = renderCallbackPage({
            kind: 'error',
            title: '<script>alert(1)</script>',
            message: 'msg',
        });
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('escapes the message against HTML injection', () => {
        const html = renderCallbackPage({
            kind: 'error',
            title: 'Error',
            message: 'attacker\'s "value" <img src=x onerror=alert(1)>',
        });
        expect(html).not.toMatch(/<img src=x onerror=alert\(1\)>/);
        expect(html).toContain('&lt;img');
        expect(html).toContain('&quot;value&quot;');
    });

    it('escapes the detail block against HTML injection', () => {
        const html = renderCallbackPage({
            kind: 'error',
            title: 'Error',
            message: 'm',
            detail: '<svg onload=alert(1)>',
        });
        expect(html).not.toMatch(/<svg onload=/);
        expect(html).toContain('&lt;svg onload=alert(1)&gt;');
    });

    it('escapes the brand name against HTML injection', () => {
        const html = renderCallbackPage({
            kind: 'success',
            title: 't',
            message: 'm',
            brandName: '<b>BAD</b>',
        });
        expect(html).not.toContain('<b>BAD</b>');
        expect(html).toContain('&lt;b&gt;BAD&lt;/b&gt;');
    });

    it('uses the default brand when none is provided', () => {
        const html = renderCallbackPage({
            kind: 'success',
            title: 't',
            message: 'm',
        });
        expect(html).toContain('MCP-SAVVY');
    });

    it('omits the detail block when no detail is given', () => {
        const html = renderCallbackPage({
            kind: 'success',
            title: 't',
            message: 'm',
        });
        expect(html).not.toContain('<div class="error-box">');
    });

    it('renders the success icon for kind=success', () => {
        const html = renderCallbackPage({ kind: 'success', title: 't', message: 'm' });
        expect(html).toContain('icon-success');
    });

    it('renders the error icon for kind=error', () => {
        const html = renderCallbackPage({ kind: 'error', title: 't', message: 'm' });
        expect(html).toContain('icon-error');
    });

    it('renders the warning icon for kind=warning', () => {
        const html = renderCallbackPage({ kind: 'warning', title: 't', message: 'm' });
        expect(html).toContain('icon-warning');
    });

    it('includes Cache-Control: no-store and referrer-policy meta tags', () => {
        const html = renderCallbackPage({ kind: 'success', title: 't', message: 'm' });
        expect(html).toContain('http-equiv="Cache-Control" content="no-store"');
        expect(html).toContain('name="referrer" content="no-referrer"');
    });
});
