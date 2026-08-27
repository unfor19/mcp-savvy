/**
 * tsup bundle config for the mcp-savvy CLI package.
 *
 * Two entry points:
 *   cli.ts  → dist/cli.cjs  (CJS, shebang preserved, executable)
 *   index.ts → dist/index.js + dist/index.cjs  (ESM + CJS for library consumers)
 *
 * All workspace deps (@mcp-savvy/*) are bundled in.
 * External deps that must stay external (node builtins handled by tsup automatically):
 *   - @modelcontextprotocol/sdk  — large, stable, let npm resolve it
 *   - proper-lockfile            — file-system locking; keep external so OS paths resolve
 */
import { defineConfig } from 'tsup';

export default defineConfig([
    {
        entry: { cli: 'src/cli.ts' },
        format: ['cjs'],
        outDir: 'dist',
        outExtension: () => ({ js: '.cjs' }),
        target: 'node20',
        platform: 'node',
        bundle: true,
        sourcemap: true,
        clean: true,
        dts: false,
        // CJS format: proper-lockfile uses dynamic require() of Node
        // builtins which breaks ESM bundling. CJS handles it cleanly.
        // outExtension forces .cjs so the bin entry in package.json
        // (dist/cli.cjs) resolves correctly under the package's ESM mode.
        external: ['@modelcontextprotocol/sdk', 'proper-lockfile'],
        noExternal: [
            '@mcp-savvy/core',
            '@mcp-savvy/auth',
            '@mcp-savvy/storage',
            '@mcp-savvy/server',
            '@mcp-savvy/bridge',
        ],
    },
    {
        entry: { index: 'src/index.ts' },
        format: ['esm', 'cjs'],
        outDir: 'dist',
        target: 'node20',
        platform: 'node',
        bundle: true,
        sourcemap: true,
        clean: false,
        dts: true,
        external: ['@modelcontextprotocol/sdk', 'proper-lockfile'],
        noExternal: [
            '@mcp-savvy/core',
            '@mcp-savvy/auth',
            '@mcp-savvy/storage',
            '@mcp-savvy/server',
            '@mcp-savvy/bridge',
        ],
        esbuildOptions(options) {
            options.conditions = ['import', 'node'];
        },
    },
]);
