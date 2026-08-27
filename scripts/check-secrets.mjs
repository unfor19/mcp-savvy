#!/usr/bin/env node
/**
 * Pre-commit secret scanner.
 *
 * Guards against accidentally committing:
 *  1. Values from `.env` (the workspace's private-by-definition file).
 *     Anything the user has in `.env` — sandbox account IDs, tenant
 *     IDs, real client IDs — must never appear in a tracked file.
 *  2. Generic secret shapes: AWS access keys, private key blocks,
 *     GitHub tokens, Slack tokens.
 *  3. Known-sensitive AWS account ID patterns (12-digit numbers
 *     appearing in obviously credential-adjacent contexts).
 *
 * Runs against `git ls-files` output, so gitignored files are
 * automatically skipped. Exits non-zero on any hit.
 *
 * Usage:
 *   node scripts/check-secrets.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Values from .env we should NEVER see in tracked files.
// Short values (< MIN_LEN chars) and well-known constants are skipped
// to keep false-positive rate low.
const MIN_LEN = 12;
const SKIP_VALUES = new Set([
    'localhost',
    '127.0.0.1',
    'us-east-1',
    'us-west-2',
    'eu-west-1',
    'true',
    'false',
]);
const PLACEHOLDER_AWS_ACCOUNT_IDS = new Set(['000000000000', '111111111111']);

function loadEnvSecrets(repoRoot) {
    const envPath = join(repoRoot, '.env');
    if (!existsSync(envPath)) return [];
    const secrets = [];
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        // strip quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!value || value.length < MIN_LEN) continue;
        if (SKIP_VALUES.has(value.toLowerCase())) continue;
        secrets.push({ key, value });
    }
    return secrets;
}

// Generic secret-shaped patterns to scan for regardless of .env
const GENERIC_PATTERNS = [
    { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: 'AWS temporary access key', pattern: /\bASIA[0-9A-Z]{16}\b/ },
    { name: 'AWS secret access key (context)', pattern: /aws_secret_access_key\s*=\s*['"]?[A-Za-z0-9/+=]{40}\b/i },
    { name: 'Private key block', pattern: /-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
    { name: 'GitHub personal access token', pattern: /\bghp_[A-Za-z0-9]{36}\b/ },
    { name: 'GitHub OAuth token', pattern: /\bgho_[A-Za-z0-9]{36}\b/ },
    { name: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/ },
    { name: 'GitHub prefixed token', pattern: /\bgh[uspr]_[A-Za-z0-9]{36,255}\b/ },
    { name: 'npm access token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
    {
        name: 'npm auth token (context)',
        pattern: /(?:_authToken|NPM_TOKEN)\s*[:=]\s*['"]?(?!\$\{)[A-Za-z0-9._~-]{20,}/i,
    },
    { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
    { name: 'OpenAI-style API key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
    {
        name: 'AWS account ID (context)',
        pattern: /\b(?:aws[_-]?account[_-]?id|awsAccountId|account[_-]?id|accountId)['"]?\s*[:=]\s*['"]?(\d{12})\b/i,
        accountIdGroup: 1,
    },
    {
        name: 'AWS account ID (CDK context)',
        pattern: /\baccount['"]?\s*:\s*['"](\d{12})\b/i,
        accountIdGroup: 1,
    },
    {
        name: 'AWS account ID (ARN)',
        pattern: /\barn:[^:\s]+:[^:\s]*:[^:\s]*:(\d{12}):[^\s]+/,
        accountIdGroup: 1,
    },
];

function indexEntries(repoRoot) {
    const output = execFileSync('git', ['ls-files', '--stage', '-z'], {
        cwd: repoRoot,
        encoding: 'buffer',
    });
    return output.toString('utf8').split('\0').filter(Boolean).flatMap((record) => {
        const match = record.match(/^[0-7]{6} ([0-9a-f]+) ([0-3])\t([\s\S]+)$/);
        if (!match) throw new Error('Unable to parse Git index entry');
        return match[2] === '0'
            ? [{ oid: match[1], file: match[3] }]
            : [];
    });
}

function findHits(content, file, source, envSecrets) {
    const hits = [];
    for (const { key, value } of envSecrets) {
        if (content.includes(value)) {
            hits.push({ file, source, kind: `env value: ${key}` });
        }
    }
    for (const { name, pattern, accountIdGroup } of GENERIC_PATTERNS) {
        const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
        for (const match of content.matchAll(new RegExp(pattern.source, flags))) {
            const accountId = accountIdGroup === undefined ? undefined : match[accountIdGroup];
            if (accountId !== undefined && PLACEHOLDER_AWS_ACCOUNT_IDS.has(accountId)) continue;
            hits.push({ file, source, kind: name });
            break;
        }
    }
    return hits;
}

/** Scan exact stage-0 blobs plus differing tracked working-tree bytes. */
export function scanRepository(repoRoot = REPO_ROOT) {
    const envSecrets = loadEnvSecrets(repoRoot);
    const entries = indexEntries(repoRoot);
    const hits = [];

    for (const { file, oid } of entries) {
        const staged = execFileSync('git', ['cat-file', 'blob', oid], {
            cwd: repoRoot,
            encoding: 'buffer',
        }).toString('latin1');
        hits.push(...findHits(staged, file, 'index', envSecrets));
        try {
            const worktree = readFileSync(join(repoRoot, file)).toString('latin1');
            if (worktree !== staged) hits.push(...findHits(worktree, file, 'worktree', envSecrets));
        } catch {
            // A staged deletion or absent worktree file has no extra bytes to scan.
        }
    }
    return { hits, fileCount: entries.length, envCount: envSecrets.length };
}

/** Scan an explicit set of files, such as the exact unpacked npm artifact. */
export function scanFiles(root, files, envRoot = REPO_ROOT) {
    const envSecrets = loadEnvSecrets(envRoot);
    const hits = [];
    for (const file of files) {
        const content = readFileSync(join(root, file)).toString('latin1');
        hits.push(...findHits(content, file, 'artifact', envSecrets));
    }
    return { hits, fileCount: files.length, envCount: envSecrets.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { hits, fileCount, envCount } = scanRepository();
    if (hits.length === 0) {
        console.log(`✓ secret scan clean (${fileCount} tracked files, ${envCount} .env values checked)`);
        process.exit(0);
    }

    console.error(`✗ secret scan found ${hits.length} hit(s):`);
    for (const h of hits) {
        console.error(`  ${h.file} (${h.source}): [${h.kind}]`);
    }
    console.error('\nFix: remove the value from the tracked file, or add it to .gitignore.');
    console.error('If this is a false positive, adjust scripts/check-secrets.mjs SKIP_VALUES.');
    process.exit(1);
}
