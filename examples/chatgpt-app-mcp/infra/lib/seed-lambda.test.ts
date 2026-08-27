/**
 * Unit tests for the chatgpt-app-mcp seed Lambda's pure helpers.
 *
 * The handler itself wires `@aws-sdk/client-dynamodb` and is exercised
 * end-to-end by the deploy-time custom resource. These tests assert
 * the JSON parsing, batching, AttributeValue mapping, and idempotent
 * `PutRequest` shape that `runSeed()` produces against a stubbed
 * DynamoDB client. They also schema-check `seed/customer-fixtures.json`
 * so a malformed fixture file fails CI before deploy.
 */

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = path.resolve(HERE, '..', '..', 'seed', 'customer-fixtures.json');
const SEED_LAMBDA_CJS = path.resolve(HERE, 'seed-lambda', 'index.cjs');

interface SeedModule {
    readonly runSeed: (deps: {
        readonly ddbClient: { send: (cmd: unknown) => Promise<unknown> };
        readonly fixturesPath: string;
        readonly tableName: string;
    }) => Promise<{ readonly itemCount: number; readonly batchCount: number }>;
    readonly readFixtures: (p: string) => ReadonlyArray<Record<string, unknown>>;
    readonly toAttributeValueMap: (item: Record<string, unknown>) => Record<string, unknown>;
}

const requireCjs = createRequire(import.meta.url);
const seed = requireCjs(SEED_LAMBDA_CJS) as SeedModule;

interface CapturedSend {
    readonly input: {
        readonly RequestItems: Record<
            string,
            ReadonlyArray<{
                readonly PutRequest: { readonly Item: Record<string, unknown> };
            }>
        >;
    };
}

describe('seed lambda', () => {
    it('parses customer-fixtures.json with the expected schema', () => {
        const items = seed.readFixtures(FIXTURES_PATH);
        expect(items.length).toBeGreaterThanOrEqual(5);
        const required = [
            'user_sub',
            'customer_id_hash',
            'currency',
            'balance_cents',
            'available_credit_cents',
            'card_last_four_masked',
            'last_updated',
        ] as const;
        for (const item of items) {
            for (const key of required) {
                expect(item[key], `missing ${key} in ${JSON.stringify(item)}`).toBeDefined();
            }
            expect(typeof item['user_sub']).toBe('string');
            expect(typeof item['balance_cents']).toBe('number');
        }
        const subs = items.map((i) => i['user_sub']);
        expect(subs).toContain('fixture-test-user-1');
    });

    it('rejects fixtures missing the items array', () => {
        const tmp = path.join(HERE, 'seed-lambda-bad-fixtures.tmp.json');
        const fs = requireCjs('node:fs') as typeof import('node:fs');
        fs.writeFileSync(tmp, JSON.stringify({ table: 'customer_data' }));
        try {
            expect(() => seed.readFixtures(tmp)).toThrow(/items/);
        } finally {
            fs.unlinkSync(tmp);
        }
    });

    it('maps JS values to DynamoDB AttributeValue shapes', () => {
        const av = seed.toAttributeValueMap({
            user_sub: 'abc',
            balance_cents: 12_345,
            verified: true,
        });
        expect(av).toEqual({
            user_sub: { S: 'abc' },
            balance_cents: { N: '12345' },
            verified: { BOOL: true },
        });
    });

    it('batches PutRequests against the configured table and is idempotent', async () => {
        const calls: CapturedSend[] = [];
        const ddbClient = {
            send: vi.fn(async (cmd: CapturedSend) => {
                calls.push(cmd);
                return {};
            }),
        };
        const result = await seed.runSeed({
            ddbClient,
            fixturesPath: FIXTURES_PATH,
            tableName: 'McpSavvyChatGptAppCustomerData',
        });

        expect(result.itemCount).toBeGreaterThanOrEqual(5);
        expect(result.batchCount).toBe(1);
        expect(calls).toHaveLength(1);
        const reqItems = calls[0]?.input.RequestItems;
        expect(reqItems).toBeDefined();
        const tableEntry = reqItems?.['McpSavvyChatGptAppCustomerData'];
        expect(tableEntry).toBeDefined();
        expect(tableEntry).toHaveLength(result.itemCount);
        for (const entry of tableEntry ?? []) {
            expect(entry.PutRequest.Item).toHaveProperty('user_sub');
            expect((entry.PutRequest.Item['user_sub'] as { S?: string }).S).toBeTypeOf('string');
        }

        const second = await seed.runSeed({
            ddbClient,
            fixturesPath: FIXTURES_PATH,
            tableName: 'McpSavvyChatGptAppCustomerData',
        });
        expect(second.itemCount).toBe(result.itemCount);
        expect(calls).toHaveLength(2);
    });
});
