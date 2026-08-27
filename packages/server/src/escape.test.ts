/**
 * Unit tests for the HTML escaper.
 */

import { describe, it, expect } from 'vitest';
import { escapeHtml } from './escape.js';

describe('escapeHtml', () => {
    it('escapes the five HTML-special characters', () => {
        expect(escapeHtml('<script>alert("x")</script>')).toBe(
            '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
        );
    });

    it('escapes single quotes', () => {
        expect(escapeHtml("a'b")).toBe('a&#39;b');
    });

    it('escapes ampersands first so existing entities stay literal', () => {
        expect(escapeHtml('&lt;')).toBe('&amp;lt;');
    });

    it('returns plain text unchanged', () => {
        expect(escapeHtml('hello world 123')).toBe('hello world 123');
    });

    it('handles empty input', () => {
        expect(escapeHtml('')).toBe('');
    });
});
