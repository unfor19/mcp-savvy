/** Regression tests for scanning the exact staged Git blobs. */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { scanFiles, scanRepository } from './check-secrets.mjs';

function git(repo, ...args) {
    execFileSync('git', args, { cwd: repo });
}

describe('scanRepository', () => {
    it('finds a staged secret after the worktree is replaced with clean bytes', () => {
        const repo = mkdtempSync(join(tmpdir(), 'mcp-savvy-secret-test-'));
        git(repo, 'init', '-q');
        const file = join(repo, 'safe name.txt');
        writeFileSync(file, `credential=${'AKIA' + 'A'.repeat(16)}\n`);
        git(repo, 'add', 'safe name.txt');
        writeFileSync(file, 'clean worktree\n');

        const result = scanRepository(repo);
        expect(result.hits).toEqual(
            expect.arrayContaining([expect.objectContaining({ file: 'safe name.txt', source: 'index' })]),
        );
    });

    it('also scans differing tracked worktree bytes', () => {
        const repo = mkdtempSync(join(tmpdir(), 'mcp-savvy-secret-test-'));
        git(repo, 'init', '-q');
        const file = join(repo, 'tracked.txt');
        writeFileSync(file, 'clean\n');
        git(repo, 'add', 'tracked.txt');
        writeFileSync(file, `credential=${'AKIA' + 'B'.repeat(16)}\n`);
        expect(scanRepository(repo).hits).toEqual(
            expect.arrayContaining([expect.objectContaining({ source: 'worktree' })]),
        );
    });

    it('never returns matched secret bytes in finding metadata', () => {
        const repo = mkdtempSync(join(tmpdir(), 'mcp-savvy-secret-test-'));
        git(repo, 'init', '-q');
        const secret = 'AKIA' + 'C'.repeat(16);
        writeFileSync(join(repo, 'tracked.txt'), `credential=${secret}\n`);
        git(repo, 'add', 'tracked.txt');

        const serialized = JSON.stringify(scanRepository(repo).hits);
        expect(serialized).not.toContain(secret);
        expect(serialized).not.toContain(secret.slice(0, 10));
    });

    it('detects contextual AWS account IDs and ARNs but permits documented placeholders', () => {
        const repo = mkdtempSync(join(tmpdir(), 'mcp-savvy-secret-test-'));
        git(repo, 'init', '-q');
        const accountId = ['1234', '5678', '9012'].join('');
        writeFileSync(
            join(repo, 'tracked.txt'),
            `AWS_ACCOUNT_ID=000000000000\nAWS_ACCOUNT_ID=${accountId}\n` +
                `env: { account: '000000000000' }\nenv: { account: '${accountId}' }\n` +
                `arn:aws:iam::111111111111:role/example\narn:aws:iam::${accountId}:role/example\n`,
        );
        writeFileSync(
            join(repo, 'placeholders.txt'),
            'AWS_ACCOUNT_ID=000000000000\narn:aws:iam::111111111111:role/example\n',
        );
        writeFileSync(join(repo, 'unrelated.txt'), `build_number=${accountId}\n`);
        git(repo, 'add', '.');

        const result = scanRepository(repo);
        expect(result.hits.filter((hit) => hit.file === 'tracked.txt')).toHaveLength(3);
        expect(result.hits.some((hit) => hit.file === 'placeholders.txt')).toBe(false);
        expect(result.hits.some((hit) => hit.file === 'unrelated.txt')).toBe(false);
    });

    it('detects modern token families embedded in binary asset metadata', () => {
        const repo = mkdtempSync(join(tmpdir(), 'mcp-savvy-secret-test-'));
        git(repo, 'init', '-q');
        const tokens = [
            'ASIA' + 'E'.repeat(16),
            'github_' + 'pat_' + 'F'.repeat(40),
            'npm_' + 'G'.repeat(36),
        ];
        writeFileSync(
            join(repo, 'asset.webp'),
            Buffer.concat([
                Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00]),
                Buffer.from(tokens.join('\0')),
            ]),
        );
        git(repo, 'add', 'asset.webp');

        const result = scanRepository(repo);
        expect(result.hits.map((hit) => hit.kind)).toEqual(expect.arrayContaining([
            'AWS temporary access key',
            'GitHub fine-grained token',
            'npm access token',
        ]));
        for (const token of tokens) expect(JSON.stringify(result.hits)).not.toContain(token);
    });

    it('detects encrypted private keys and hyphenated project API keys', () => {
        const repo = mkdtempSync(join(tmpdir(), 'mcp-savvy-secret-test-'));
        git(repo, 'init', '-q');
        const projectKey = ['sk', 'proj', 'I'.repeat(32)].join('-');
        const encryptedKeyHeader = ['-----BEGIN', 'ENCRYPTED PRIVATE KEY-----'].join(' ');
        writeFileSync(
            join(repo, 'credentials.txt'),
            `${encryptedKeyHeader}\n${projectKey}\n`,
        );
        git(repo, 'add', 'credentials.txt');

        const result = scanRepository(repo);
        expect(result.hits.map((hit) => hit.kind)).toEqual(expect.arrayContaining([
            'Private key block',
            'OpenAI-style API key',
        ]));
        expect(JSON.stringify(result.hits)).not.toContain(projectKey);
    });
});

describe('scanFiles', () => {
    it('scans an explicit untracked artifact without returning matched bytes', () => {
        const root = mkdtempSync(join(tmpdir(), 'mcp-savvy-artifact-test-'));
        const secret = 'AKIA' + 'D'.repeat(16);
        writeFileSync(join(root, 'artifact.js'), `export const credential = '${secret}';\n`);

        const result = scanFiles(root, ['artifact.js'], root);
        expect(result.hits).toEqual([
            expect.objectContaining({ file: 'artifact.js', source: 'artifact' }),
        ]);
        expect(JSON.stringify(result.hits)).not.toContain(secret);
    });

    it('scans binary files in an unpacked artifact', () => {
        const root = mkdtempSync(join(tmpdir(), 'mcp-savvy-artifact-test-'));
        const secret = 'npm_' + 'H'.repeat(36);
        writeFileSync(
            join(root, 'asset.png'),
            Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), Buffer.from(secret)]),
        );

        const result = scanFiles(root, ['asset.png'], root);
        expect(result.hits).toEqual([
            expect.objectContaining({ file: 'asset.png', kind: 'npm access token' }),
        ]);
        expect(JSON.stringify(result.hits)).not.toContain(secret);
    });
});
