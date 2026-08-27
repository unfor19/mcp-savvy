#!/usr/bin/env node
/**
 * Seed `customer_data` from live Cognito users.
 *
 * For each `CONFIRMED` Cognito user in the configured pool, ensure
 * a `customer_data` row exists keyed by their real Cognito `sub`.
 * Synthetic banking values are derived deterministically from the
 * sub via SHA-256 so reruns produce stable rows.
 *
 * Idempotent by default: skips users that already have a row.
 * Pass `FORCE=1` to overwrite existing rows.
 *
 * Required env: `USER_POOL`, `CUSTOMER_TABLE`.
 * Optional env: `AWS_PROFILE`, `AWS_REGION` (default us-east-1),
 *               `FORCE` (=1 overwrites).
 */

import { createHash } from 'node:crypto';
import { env, exit, stderr, stdout } from 'node:process';

import { aws } from './aws.mjs';

const required = ['USER_POOL', 'CUSTOMER_TABLE'];
for (const key of required) {
    if (!env[key]) {
        stderr.write(`Missing required env var: ${key}\n`);
        exit(1);
    }
}

const FORCE = env.FORCE === '1' || env.FORCE === 'true';
const CURRENCIES = ['USD', 'EUR', 'GBP', 'ILS', 'JPY'];

/** Read a single attribute value from a Cognito user object. */
function attribute(user, name) {
    return user.Attributes?.find((a) => a.Name === name)?.Value;
}

/** Page through every user in the pool. */
function listCognitoUsers() {
    const all = [];
    let nextToken;
    for (; ;) {
        const args = [
            'cognito-idp', 'list-users',
            '--user-pool-id', env.USER_POOL,
            '--limit', '60',
            '--output', 'json',
        ];
        if (nextToken) args.push('--pagination-token', nextToken);
        const parsed = JSON.parse(aws(args));
        all.push(...(parsed.Users ?? []));
        nextToken = parsed.PaginationToken;
        if (!nextToken) break;
    }
    return all;
}

/**
 * Build a deterministic synthetic row from the sub. Banking field
 * shapes match `seed/customer-fixtures.json` exactly so the tool's
 * `getCustomer` lookup treats real-user rows and fixtures
 * identically.
 */
function buildRow(sub) {
    const hash = createHash('sha256').update(sub).digest('hex');
    const balance = 5_000 + (parseInt(hash.slice(0, 8), 16) % 1_495_000);
    const credit = 500_000 + (parseInt(hash.slice(8, 16), 16) % 2_000_000);
    const lastFour = String(parseInt(hash.slice(16, 20), 16) % 10_000).padStart(4, '0');
    const currency = CURRENCIES[parseInt(hash.slice(20, 24), 16) % CURRENCIES.length];
    return {
        user_sub: { S: sub },
        customer_id_hash: { S: `live-${hash.slice(0, 32)}` },
        currency: { S: currency },
        balance_cents: { N: String(balance) },
        available_credit_cents: { N: String(credit) },
        card_last_four_masked: { S: `**** **** **** ${lastFour}` },
        last_updated: { S: new Date().toISOString() },
    };
}

/** Read an existing customer_data row (if any) for the given sub. */
function existingRow(sub) {
    const out = aws([
        'dynamodb', 'get-item',
        '--table-name', env.CUSTOMER_TABLE,
        '--key', JSON.stringify({ user_sub: { S: sub } }),
        '--consistent-read',
        '--output', 'json',
    ]);
    return JSON.parse(out || '{}').Item ?? null;
}

/** Put a row; AWS-managed encryption + PITR are configured at the table. */
function putRow(item) {
    aws([
        'dynamodb', 'put-item',
        '--table-name', env.CUSTOMER_TABLE,
        '--item', JSON.stringify(item),
    ]);
}

const users = listCognitoUsers();
const counts = { created: 0, overwritten: 0, skipped: 0, unconfirmed: 0, noSub: 0 };

stdout.write(`\n  Seeding customer_data (${users.length} user(s), FORCE=${FORCE})\n\n`);

for (const user of users) {
    const status = user.UserStatus;
    if (status !== 'CONFIRMED' && status !== 'EXTERNAL_PROVIDER') {
        counts.unconfirmed++;
        continue;
    }
    const sub = attribute(user, 'sub');
    if (!sub) {
        counts.noSub++;
        continue;
    }
    const existing = existingRow(sub);
    if (existing && !FORCE) {
        counts.skipped++;
        continue;
    }
    const row = buildRow(sub);
    putRow(row);
    if (existing) {
        counts.overwritten++;
    } else {
        counts.created++;
    }
}

stdout.write(
    `\n  Summary: ${counts.created} created, ${counts.overwritten} overwritten, ` +
    `${counts.skipped} skipped, ${counts.unconfirmed} unconfirmed, ${counts.noSub} missing-sub\n`,
);
