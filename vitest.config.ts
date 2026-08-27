/**
 * Root vitest config. Per-package configs extend this with their own
 * `include` / `setupFiles` if needed.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Co-locate tests with source: foo.ts + foo.test.ts.
        // The .test.ts extension is fon-exempt from prefix-grouping.
        // Examples emit `.mjs` source so we also accept `.test.mjs`
        // there — vitest's TS pipeline transparently handles ESM.
        include: ['packages/**/*.test.ts', 'examples/**/*.test.{ts,mjs}', 'scripts/**/*.test.mjs'],
        exclude: ['**/node_modules/**', '**/dist/**', '**/cdk.out/**'],
        // Storage tests shell out to platform CLIs; isolate so one
        // package's keychain probe can't pollute another's process state.
        isolate: true,
        // Default 5s is fine for unit tests; integration tests can
        // override per-test with `it('...', { timeout: 30_000 }, ...)`.
        testTimeout: 5_000,
        coverage: {
            provider: 'v8',
            // Report every source file (even ones not loaded by a test)
            // so we see real coverage gaps, not just covered files.
            all: true,
            reporter: ['text', 'html', 'lcov'],
            include: ['packages/**/src/**/*.ts'],
            exclude: [
                'packages/**/src/**/*.test.ts',
                'packages/**/src/**/index.ts',
                'packages/**/src/**/testFixtures.ts',
                'packages/**/dist/**',
                'packages/**/node_modules/**',
            ],
            thresholds: {
                // Logic packages target ≥80% by v0.1. CDK + CLI tighten later.
                lines: 70,
                functions: 70,
                branches: 70,
                statements: 70,
            },
        },
    },
});
