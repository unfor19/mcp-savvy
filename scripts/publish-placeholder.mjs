#!/usr/bin/env node
/**
 * Stage and pack the retired `mcp-savvy@0.0.1` placeholder package.
 *
 * The placeholder exists solely to reserve the npm namespace ahead of
 * the real v0.1.0 release. The published tarball is a tiny stub that
 * prints a "preview release" message and links back to the GitHub
 * repo — it does NOT contain the real CLI. The real `packages/cli/`
 * source tree is never touched.
 *
 * Usage:
 *   node scripts/publish-placeholder.mjs            # pack only (dry-run-ish)
 * This script intentionally has no upload mode. Public releases use
 * `scripts/release-cli.mjs`, which verifies and publishes an immutable
 * inspected tarball.
 */

import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.length > 2) {
    console.error('Placeholder publishing is retired; this command only packs.');
    process.exit(2);
}

const pkg = {
    name: 'mcp-savvy',
    version: '0.0.1',
    description:
        'Placeholder for the mcp-savvy CLI — toolkit for shipping protected MCP servers on AWS. Real release coming soon.',
    keywords: ['mcp', 'aws', 'agentcore', 'cognito', 'oauth', 'oidc', 'bridge', 'placeholder'],
    homepage: 'https://github.com/unfor19/mcp-savvy#readme',
    bugs: { url: 'https://github.com/unfor19/mcp-savvy/issues' },
    repository: { type: 'git', url: 'git+https://github.com/unfor19/mcp-savvy.git' },
    license: 'MIT',
    type: 'module',
    bin: { 'mcp-savvy': './bin.js' },
    files: ['bin.js'],
    engines: { node: '>=20' },
    publishConfig: { access: 'public' },
};

const binJs = `#!/usr/bin/env node
process.stderr.write('mcp-savvy: v0.0.1 placeholder — preview release. The real CLI ships at v0.1.0.\\n');
process.stderr.write('Track progress: https://github.com/unfor19/mcp-savvy\\n');
process.exit(1);
`;

const readme = `# mcp-savvy

> The expert MCP deployer, so you only deal with your app.

This npm release (\`v0.0.1\`) is a **placeholder** reserving the
namespace. The real CLI ships at \`v0.1.0\`.

For now, see [github.com/unfor19/mcp-savvy](https://github.com/unfor19/mcp-savvy)
for the working examples (CDK constructs + end-to-end deployments).
`;

const staging = mkdtempSync(join(tmpdir(), 'mcp-savvy-placeholder-'));
writeFileSync(join(staging, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
writeFileSync(join(staging, 'bin.js'), binJs);
writeFileSync(join(staging, 'README.md'), readme);
copyFileSync(join(REPO_ROOT, 'LICENSE'), join(staging, 'LICENSE'));

console.log(`\nStaged placeholder in: ${staging}\n`);

const npmArgs = ['pack', '--pack-destination', staging];
const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !['OTP', 'NPM_CONFIG_OTP'].includes(name.toUpperCase())),
);
const result = spawnSync('npm', npmArgs, { cwd: staging, stdio: 'inherit', env: childEnv });

if (result.status !== 0) {
    console.error(`\nPlaceholder pack failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
}

console.log(`\nTarball staged at ${staging}/mcp-savvy-0.0.1.tgz\n`);
