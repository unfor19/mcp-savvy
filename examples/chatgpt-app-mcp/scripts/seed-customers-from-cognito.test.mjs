/** Static regression tests for privacy-safe seed-script output. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
    fileURLToPath(new URL('./seed-customers-from-cognito.mjs', import.meta.url)),
    'utf8',
);

describe('seed customer output', () => {
    it('prints aggregate counts without per-record identifiers or fixture values', () => {
        expect(source).not.toMatch(/attribute\(user, ['"]email['"]\)/);
        expect(source).not.toContain('formatAmount');
        expect(source).not.toMatch(/stdout\.write\([^\n]*(?:sub|label|email|row)/);
        expect(source).toContain('Summary:');
    });
});
