/**
 * Integration test for the default `nodeRunner`. We don't shell out
 * to the real keychain CLIs (those are platform-specific and tested
 * via the per-OS integration matrix); we use `node` itself, which is
 * always present.
 */

import { describe, it, expect } from 'vitest';
import { nodeRunner } from './runner.js';

describe('nodeRunner.run', () => {
    it('returns stdout from a successful command', () => {
        // `node -e "process.stdout.write('hello')"` is portable.
        const out = nodeRunner.run('node', ['-e', "process.stdout.write('hello')"]);
        expect(out).toBe('hello');
    });

    it('throws when the command exits non-zero', () => {
        expect(() => nodeRunner.run('node', ['-e', 'process.exit(1)'])).toThrow();
    });

    it('throws when the command does not exist', () => {
        expect(() =>
            nodeRunner.run('this-binary-definitely-does-not-exist-mcp-savvy', []),
        ).toThrow();
    });
});

describe('nodeRunner.runWithStdin', () => {
    it('pipes stdin and reports status 0 on success', () => {
        const result = nodeRunner.runWithStdin(
            'node',
            ['-e', 'process.stdin.on("data", () => process.exit(0))'],
            'hello',
        );
        expect(result.status).toBe(0);
    });

    it('reports non-zero status on failure', () => {
        const result = nodeRunner.runWithStdin('node', ['-e', 'process.exit(7)'], 'irrelevant');
        expect(result.status).toBe(7);
    });
});
