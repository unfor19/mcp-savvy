/** Static regression guard against logging caller or retrieval content. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const agent = readFileSync(fileURLToPath(new URL('./agent.py', import.meta.url)), 'utf8');
const retrieval = readFileSync(fileURLToPath(new URL('./tools/kb.py', import.meta.url)), 'utf8');

describe('KB operational logging', () => {
    it('records only prompt and result metadata', () => {
        expect(agent).toContain('ask prompt_len=%d');
        expect(agent).toContain('source_count=%d');
        expect(agent).not.toContain('prompt[:');
        expect(agent).not.toContain('logger.info("ask prompt=%r"');
        expect(agent).not.toContain('sources_raw');
    });

    it('records retrieval length and error type without query or exception text', () => {
        expect(retrieval).toContain('query_len=%d k=%d error_type=%s');
        expect(retrieval).not.toMatch(/logger\.(?:exception|error)\([^\n]*query=%r/);
        expect(retrieval).not.toContain('logger.exception');
    });
});
