/** Cross-process acceptance scenarios for reusable authentication sessions. */

import assert from 'node:assert/strict';

import { spawnAuthFixture } from './index.mjs';

const NOW_MS = 1_700_000_000_000;
const FRESH_EXPIRY_MS = NOW_MS + 300_000;
const STALE_EXPIRY_MS = NOW_MS + 30_000;
const LOCK_HOLD_MS = 400;
const LOCK_TIMEOUT_MS = 100;

function tokens(accessToken, expiresAt, refreshToken) {
    return {
        access_token: accessToken,
        expires_at: expiresAt,
        ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
    };
}

function fixtureInput(input, processLabel) {
    return {
        processLabel,
        dataDir: input.dataDir,
        namespace: input.namespace,
        nowMs: NOW_MS,
        lockTimeoutMs: input.lockTimeoutMs ?? 2_000,
        authorizationTokens: input.authorizationTokens
            ?? tokens('fixture-pkce-access', FRESH_EXPIRY_MS, 'fixture-refresh'),
        refreshTokens: input.refreshTokens
            ?? tokens('fixture-refreshed-access', FRESH_EXPIRY_MS, 'fixture-refresh-next'),
        authorizationDelayMs: input.authorizationDelayMs,
        refreshDelayMs: input.refreshDelayMs,
    };
}

function eventCount(fixtures, event) {
    return fixtures.reduce(
        (count, fixture) => count + fixture.observations.filter(
            (observation) => observation.event === event,
        ).length,
        0,
    );
}

async function closeFixtures(fixtures) {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
}

async function verifyOnePkce(input) {
    const fixtures = await Promise.all([
        spawnAuthFixture(fixtureInput({ ...input, authorizationDelayMs: 150 }, 'pkce-a')),
        spawnAuthFixture(fixtureInput({ ...input, authorizationDelayMs: 150 }, 'pkce-b')),
    ]);
    try {
        const results = await Promise.all(fixtures.map(
            (fixture) => fixture.request('authenticate'),
        ));
        assert.deepEqual(results.map((result) => result.accessToken), [
            'fixture-pkce-access',
            'fixture-pkce-access',
        ]);
        for (const event of [
            'authorization-prepare',
            'authorization-exchange',
            'browser-launch',
            'store-write',
        ]) {
            assert.equal(eventCount(fixtures, event), 1, `expected exactly one ${event}`);
        }
    } finally {
        await closeFixtures(fixtures);
    }
}

async function verifyOneRefresh(input) {
    const seeder = await spawnAuthFixture(fixtureInput(input, 'refresh-seeder'));
    await seeder.request('seed', {
        tokens: tokens('fixture-stale-access', STALE_EXPIRY_MS, 'fixture-stale-refresh'),
    });
    await seeder.close();

    const fixtures = await Promise.all([
        spawnAuthFixture(fixtureInput({ ...input, refreshDelayMs: 150 }, 'refresh-a')),
        spawnAuthFixture(fixtureInput({ ...input, refreshDelayMs: 150 }, 'refresh-b')),
    ]);
    try {
        const results = await Promise.all(fixtures.map(
            (fixture) => fixture.request('authenticate'),
        ));
        assert.deepEqual(results.map((result) => result.accessToken), [
            'fixture-refreshed-access',
            'fixture-refreshed-access',
        ]);
        assert.equal(eventCount(fixtures, 'refresh-attempt'), 1);
        assert.equal(eventCount(fixtures, 'store-write'), 1);
        assert.equal(eventCount(fixtures, 'browser-launch'), 0);
    } finally {
        await closeFixtures(fixtures);
    }
}

async function verifyExitedProcessReuse(input) {
    const writer = await spawnAuthFixture(fixtureInput(input, 'restart-writer'));
    const first = await writer.request('authenticate');
    assert.equal(first.accessToken, 'fixture-pkce-access');
    assert.equal(eventCount([writer], 'browser-launch'), 1);
    await writer.close();

    const reader = await spawnAuthFixture(fixtureInput(input, 'restart-reader'));
    try {
        const second = await reader.request('authenticate');
        assert.equal(second.accessToken, first.accessToken);
        for (const event of [
            'authorization-prepare',
            'authorization-exchange',
            'refresh-attempt',
            'browser-launch',
            'store-write',
        ]) {
            assert.equal(eventCount([reader], event), 0, `later process performed ${event}`);
        }
    } finally {
        await reader.close();
    }
}

async function verifyTimeoutHasNoSideEffects(input) {
    const holder = await spawnAuthFixture(fixtureInput(input, 'timeout-holder'));
    const contender = await spawnAuthFixture(fixtureInput({
        ...input,
        lockTimeoutMs: LOCK_TIMEOUT_MS,
    }, 'timeout-contender'));
    try {
        const held = holder.request('hold-lock', { holdMs: LOCK_HOLD_MS });
        await holder.waitForObservation((observation) => observation.event === 'lock-held');
        await assert.rejects(
            contender.request('authenticate'),
            (error) => error.code === 'LOCK_ACQUISITION_TIMEOUT',
        );
        const forbiddenEvents = [
            'store-read',
            'store-write',
            'store-clear',
            'refresh-attempt',
            'authorization-prepare',
            'authorization-exchange',
            'callback-listen',
            'callback-received',
            'browser-launch',
        ];
        for (const event of forbiddenEvents) {
            assert.equal(eventCount([contender], event), 0, `timed-out process performed ${event}`);
        }
        await held;
    } finally {
        await closeFixtures([holder, contender]);
    }
}

async function verifyProcessLocalTransports(input) {
    const seeder = await spawnAuthFixture(fixtureInput(input, 'transport-seeder'));
    await seeder.request('seed', {
        tokens: tokens('fixture-transport-access', FRESH_EXPIRY_MS),
    });
    await seeder.close();

    const fixtures = await Promise.all([
        spawnAuthFixture(fixtureInput(input, 'transport-a')),
        spawnAuthFixture(fixtureInput(input, 'transport-b')),
    ]);
    try {
        const results = await Promise.all(fixtures.map(
            (fixture) => fixture.request('transport', { closeAfterMs: 0 }),
        ));
        assert.equal(results.length, 2);
        assert.notEqual(results[0].owner, results[1].owner);
        assert.equal(results[0].remoteIds.length, 1);
        assert.equal(results[1].remoteIds.length, 1);
        assert.notEqual(results[0].remoteIds[0], results[1].remoteIds[0]);
        fixtures.forEach((fixture, index) => {
            const created = fixture.observations.filter(
                (observation) => observation.event === 'transport-created',
            );
            assert.equal(created.length, 1);
            assert.equal(created[0].details.owner, results[index].owner);
            assert.equal(created[0].details.transportId, results[index].remoteIds[0]);
        });
    } finally {
        await closeFixtures(fixtures);
    }
}

/** Run task 5.2 authentication reuse and transport-ownership acceptance scenarios. */
export async function runAuthReuseAcceptanceTests(input) {
    const scenarios = [
        ['one PKCE result for sibling processes', verifyOnePkce],
        ['one refresh result for stale sibling processes', verifyOneRefresh],
        ['credential reuse after the writer process exits', verifyExitedProcessReuse],
        ['lock timeout with zero authentication side effects', verifyTimeoutHasNoSideEffects],
        ['process-local remote transport ownership', verifyProcessLocalTransports],
    ];
    for (const [name, scenario] of scenarios) {
        await scenario({
            dataDir: input.dataDir,
            namespace: `${input.namespace}-${name.replaceAll(' ', '-')}`,
        });
        process.stdout.write(`  ✓ ${name}\n`);
    }
}
