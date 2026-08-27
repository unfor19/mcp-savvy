/**
 * tsup bundle config for the mcp-savvy CLI package.
 *
 * Two entry points:
 *   cli.ts  → dist/cli.js   (ESM, shebang preserved, executable)
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
        // outExtension forces .js so the bin entry in package.json
        // (dist/cli.js) resolves correctly.
        external: ['@modelcontextprotocol/sdk'],
        noExternal: [
            '@mcp-savvy/core',
            '@mcp-savvy/auth',
            '@mcp-savvy/storage',
            '@mcp-savvy/server',
            '@mcp-savvy/bridge',
            'proper-lockfile',
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
        external: ['@modelcontextprotocol/sdk'],
        noExternal: [
            '@mcp-savvy/core',
            '@mcp-savvy/auth',
            '@mcp-savvy/storage',
            '@mcp-savvy/server',
            '@mcp-savvy/bridge',
            'proper-lockfile',
        ],
        esbuildOptions(options) {
            options.conditions = ['import', 'node'];
        },
    },
]);
