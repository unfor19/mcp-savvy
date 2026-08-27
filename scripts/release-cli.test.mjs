/** Regression tests for the verified immutable npm publication path. */

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const RELEASE_SCRIPT = new URL('./release-cli.mjs', import.meta.url);

function fakeTools(failVerify = false) {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-savvy-release-test-'));
    const record = join(dir, 'calls.log');
    const make = join(dir, 'make');
    const npm = join(dir, 'npm');
    writeFileSync(make, `#!/usr/bin/env node
require('fs').appendFileSync(process.env.RECORD, 'make ' + process.argv.slice(2).join(' ') + '\\n');
process.exit(process.env.FAIL_VERIFY === '1' ? 1 : 0);
`);
    writeFileSync(npm, `#!/usr/bin/env node
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const args = process.argv.slice(2); fs.appendFileSync(process.env.RECORD, 'npm ' + args.join(' ') + '\\n');
if (args[0] === 'pack') {
  const destination = args[args.indexOf('--pack-destination') + 1]; const filename = 'mcp-savvy-test.tgz';
  const files = ['package.json','README.md','LICENSE','dist/cli.cjs','dist/index.js','dist/index.d.ts'].map(path => ({ path }));
  const root = path.join(destination, 'fixture', 'package');
  for (const entry of files) {
    const file = path.join(root, entry.path); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entry.path === 'package.json' ? '{}' : 'clean artifact');
  }
  execFileSync('tar', ['-czf', path.join(destination, filename), '-C', path.dirname(root), 'package']);
  process.stdout.write(JSON.stringify([{ filename, files }]));
}
`);
    chmodSync(make, 0o755);
    chmodSync(npm, 0o755);
    return {
        record,
        env: {
            ...process.env,
            PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
            RECORD: record,
            FAIL_VERIFY: failVerify ? '1' : '0',
            OTP: 'must-not-be-forwarded',
        },
    };
}

describe('release-cli', () => {
    it('runs verify, inspects a new tarball, and publishes that exact file', () => {
        const fake = fakeTools();
        const result = spawnSync(process.execPath, [RELEASE_SCRIPT.pathname, '--publish'], {
            env: fake.env,
            encoding: 'utf8',
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        const calls = readFileSync(fake.record, 'utf8').trim().split('\n');
        expect(calls[0]).toBe('make verify');
        expect(calls[1]).toContain('npm pack --json --pack-destination');
        expect(calls[2]).toMatch(/^npm publish .*mcp-savvy-test\.tgz --access public$/);
        expect(calls.join(' ')).not.toContain('must-not-be-forwarded');
    });

    it('does not invoke npm when verification fails', () => {
        const fake = fakeTools(true);
        const result = spawnSync(process.execPath, [RELEASE_SCRIPT.pathname, '--publish'], {
            env: fake.env,
            encoding: 'utf8',
        });
        expect(result.status).not.toBe(0);
        expect(readFileSync(fake.record, 'utf8')).toBe('make verify\n');
    });
});
