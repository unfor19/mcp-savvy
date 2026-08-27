#!/usr/bin/env node
/** Verify, pack, inspect, and optionally publish the immutable CLI tarball. */

import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanFiles } from './check-secrets.mjs';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = join(repo, 'packages', 'cli');
const publish = process.argv.includes('--publish');
const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !['OTP', 'NPM_CONFIG_OTP'].includes(name.toUpperCase())),
);
const unexpected = process.argv.slice(2).filter((arg) => arg !== '--publish');
if (unexpected.length > 0) {
    console.error('Usage: node scripts/release-cli.mjs [--publish]');
    process.exit(2);
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { stdio: 'inherit', env: childEnv, ...options });
    if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

if (publish) run('make', ['verify'], { cwd: repo });
const destination = mkdtempSync(join(tmpdir(), 'mcp-savvy-release-'));
const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', destination], {
    cwd: cli,
    encoding: 'utf8',
    env: childEnv,
});
if (packed.status !== 0) throw new Error(`npm pack failed with exit code ${packed.status}`);

const reports = JSON.parse(packed.stdout);
if (!Array.isArray(reports) || reports.length !== 1) throw new Error('npm pack returned no unique artifact');
const report = reports[0];
const files = new Set((report.files ?? []).map((entry) => entry.path));
for (const required of ['package.json', 'README.md', 'LICENSE', 'dist/cli.cjs', 'dist/index.js', 'dist/index.d.ts']) {
    if (!files.has(required)) throw new Error(`packed artifact is missing ${required}`);
}
for (const file of files) {
    if (!(file === 'package.json' || file === 'README.md' || file === 'LICENSE' || file.startsWith('dist/'))) {
        throw new Error(`packed artifact contains unexpected path ${file}`);
    }
}
const tarball = join(destination, report.filename);
if (!existsSync(tarball)) throw new Error('npm pack reported an artifact that does not exist');
const extracted = join(destination, 'unpacked');
mkdirSync(extracted);
run('tar', ['-xzf', tarball, '-C', extracted]);
const artifactScan = scanFiles(join(extracted, 'package'), [...files], repo);
if (artifactScan.hits.length > 0) {
    throw new Error(`packed artifact failed the secret scan (${artifactScan.hits.length} hit(s))`);
}
console.log(`Inspected immutable artifact: ${tarball}`);
if (publish) {
    run('npm', ['publish', tarball, '--access', 'public'], { cwd: repo });
}
