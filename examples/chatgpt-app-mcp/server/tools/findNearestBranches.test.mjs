/**
 * Unit tests for `find_nearest_branches`.
 *
 * Stubs the branches loader and freezes time so Haversine ranking
 * + open-now filtering are deterministic. Asserts:
 *   - Tool definition is model-visible and points at the branches widget
 *   - Ranks by Haversine distance when `_meta["openai/userLocation"]` is present
 *   - Honours `mustBeOpen: false` (returns closed branches too)
 *   - Falls back gracefully when location is missing
 *   - Builds Google Maps directions URLs with the right origin
 *   - Clamps `limit` to [1, 10]
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    findNearestBranches,
    TOOL_DEFINITION,
    TOOL_NAME,
} from './findNearestBranches.mjs';
import { WIDGETS } from '../widgetUri.mjs';

const FIXTURE_BRANCHES = [
    {
        branch_id: 'b-ta-1',
        name: 'Savvy TA Rothschild',
        address: '56 Rothschild Blvd, Tel Aviv',
        city: 'Tel Aviv',
        region: 'Israel',
        lat: 32.0628, lon: 34.7720,
        timezone: 'Asia/Jerusalem',
        hours: {
            sun: '09:00-17:00', mon: '09:00-17:00', tue: '09:00-17:00',
            wed: '09:00-17:00', thu: '09:00-17:00', fri: '09:00-14:00', sat: 'closed',
        },
    },
    {
        branch_id: 'b-pt-1',
        name: 'Savvy PT Jabotinsky',
        address: '10 Jabotinsky St, Petah Tikva',
        city: 'Petah Tikva',
        region: 'Israel',
        lat: 32.0840, lon: 34.8878,
        timezone: 'Asia/Jerusalem',
        hours: {
            sun: '09:00-17:00', mon: '09:00-17:00', tue: '09:00-17:00',
            wed: '09:00-17:00', thu: '09:00-17:00', fri: '09:00-14:00', sat: 'closed',
        },
    },
    {
        branch_id: 'b-jer-1',
        name: 'Savvy Jerusalem Jaffa',
        address: '38 Jaffa Rd, Jerusalem',
        city: 'Jerusalem',
        region: 'Israel',
        lat: 31.7837, lon: 35.2200,
        timezone: 'Asia/Jerusalem',
        hours: {
            sun: '09:00-17:00', mon: '09:00-17:00', tue: '09:00-17:00',
            wed: '09:00-17:00', thu: '09:00-17:00', fri: '09:00-14:00', sat: 'closed',
        },
    },
    {
        branch_id: 'b-eilat-1',
        name: 'Savvy Eilat Promenade',
        address: '1 HaTmarim Blvd, Eilat',
        city: 'Eilat',
        region: 'Israel',
        lat: 29.5570, lon: 34.9520,
        timezone: 'Asia/Jerusalem',
        hours: { sun: 'closed', mon: 'closed', tue: 'closed', wed: 'closed', thu: 'closed', fri: 'closed', sat: 'closed' },
    },
];

// Wed 2026-06-17 at 11:00 UTC = 14:00 Asia/Jerusalem; weekday branches open, Eilat (always closed) shut.
const WED_AT_NOON_LOCAL = new Date('2026-06-17T11:00:00Z');

// User at Habima Square, Tel Aviv.
const USER_LOC_TA = {
    city: 'Tel Aviv',
    region: 'Tel Aviv District',
    country: 'IL',
    timezone: 'Asia/Jerusalem',
    longitude: 34.7795,
    latitude: 32.0738,
};

// User at downtown Petah Tikva.
const USER_LOC_PT = {
    city: 'Petah Tikva',
    region: 'Center District',
    country: 'IL',
    timezone: 'Asia/Jerusalem',
    longitude: 34.8878,
    latitude: 32.0840,
};

describe('find_nearest_branches', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('publishes the expected tool definition shape', () => {
        expect(TOOL_NAME).toBe('find_nearest_branches');
        expect(TOOL_DEFINITION.name).toBe(TOOL_NAME);
        expect(TOOL_DEFINITION.annotations.readOnlyHint).toBe(true);
        expect(TOOL_DEFINITION.annotations.openWorldHint).toBe(false);
        // Model-visible — must NOT be hidden behind `["app"]`.
        expect(TOOL_DEFINITION._meta?.ui?.visibility).toBeUndefined();
        expect(TOOL_DEFINITION._meta?.ui?.resourceUri).toBe(WIDGETS.branches.uri);
        // Input schema doesn't ask for location — that's per-Apps-SDK guidance.
        expect(TOOL_DEFINITION.inputSchema.properties).not.toHaveProperty('lat');
        expect(TOOL_DEFINITION.inputSchema.properties).not.toHaveProperty('lon');
        expect(TOOL_DEFINITION.inputSchema.properties).not.toHaveProperty('address');
    });

    it('ranks branches by Haversine distance from user_location', async () => {
        const result = await findNearestBranches(
            {},
            { requestMeta: { 'openai/userLocation': USER_LOC_TA } },
            { fetchBranches: async () => FIXTURE_BRANCHES, now: WED_AT_NOON_LOCAL },
        );
        const branches = result.structuredContent.branches;
        // Tel Aviv user → TA branch is ~1 km away, PT is ~10 km, Jerusalem ~60 km.
        expect(branches.map((b) => b.branch_id)).toEqual(['b-ta-1', 'b-pt-1', 'b-jer-1']);
        expect(branches[0].distanceKm).toBeLessThan(2);
        expect(branches[1].distanceKm).toBeGreaterThan(branches[0].distanceKm);
        expect(branches[2].distanceKm).toBeGreaterThan(branches[1].distanceKm);
    });

    it('reranks correctly when user moves locations', async () => {
        const taResult = await findNearestBranches(
            { limit: 1 },
            { requestMeta: { 'openai/userLocation': USER_LOC_TA } },
            { fetchBranches: async () => FIXTURE_BRANCHES, now: WED_AT_NOON_LOCAL },
        );
        const ptResult = await findNearestBranches(
            { limit: 1 },
            { requestMeta: { 'openai/userLocation': USER_LOC_PT } },
            { fetchBranches: async () => FIXTURE_BRANCHES, now: WED_AT_NOON_LOCAL },
        );
        expect(taResult.structuredContent.branches[0].branch_id).toBe('b-ta-1');
        expect(ptResult.structuredContent.branches[0].branch_id).toBe('b-pt-1');
    });

    it('filters closed branches by default and includes them when mustBeOpen=false', async () => {
        const open = await findNearestBranches(
            {},
            { requestMeta: { 'openai/userLocation': USER_LOC_TA } },
            { fetchBranches: async () => FIXTURE_BRANCHES, now: WED_AT_NOON_LOCAL },
        );
        // Eilat is closed every day in this fixture → never appears.
        expect(open.structuredContent.branches.find((b) => b.branch_id === 'b-eilat-1')).toBeUndefined();

        const all = await findNearestBranches(
            { mustBeOpen: false, limit: 10 },
            { requestMeta: { 'openai/userLocation': USER_LOC_TA } },
            { fetchBranches: async () => FIXTURE_BRANCHES, now: WED_AT_NOON_LOCAL },
        );
        expect(all.structuredContent.branches.find((b) => b.branch_id === 'b-eilat-1')).toBeDefined();
    });

    it('falls back to a city-sorted list when user location is missing entirely', async () => {
        const result = await findNearestBranches(
            {},
            { requestMeta: {} },
            { fetchBranches: async () => FIXTURE_BRANCHES, now: WED_AT_NOON_LOCAL },
        );
        expect(result.structuredContent.usedFallback).toBe(true);
        // Branches sorted alphabetically by city: Jerusalem, Petah Tikva, Tel Aviv (Eilat is closed).
        const cities = result.structuredContent.branches.map((b) => b.city);
        expect(cities).toEqual(['Jerusalem', 'Petah Tikva', 'Tel Aviv']);
        // No distance ranking on fallback.
        for (const b of result.structuredContent.branches) {
            expect(b.distanceKm).toBeUndefined();
        }
    });

    it('synthesises an origin from city centroid when only userLocation.city is provided', async () => {
        // No coords, just a recognised city — code should centroid the
        // matching branches and rank by distance from that centroid.
        const result = await findNearestBranches(
            { limit: 1 },
            { requestMeta: { 'openai/userLocation': { city: 'Tel Aviv' } } },
            { fetchBranches: async () => FIXTURE_BRANCHES, now: WED_AT_NOON_LOCAL },
        );
        expect(result.structuredContent.usedFallback).toBeUndefined();
        expect(result.structuredContent.branches[0].branch_id).toBe('b-ta-1');
        expect(typeof result.structuredContent.branches[0].distanceKm).toBe('number');
    });

    it('builds Google Maps directions URLs without origin (Maps uses device location)', async () => {
        const result = await findNearestBranches(
            { limit: 1 },
            { requestMeta: { 'openai/userLocation': USER_LOC_TA } },
            { fetchBranches: async () => FIXTURE_BRANCHES, now: WED_AT_NOON_LOCAL },
        );
        const branch = result.structuredContent.branches[0];
        expect(branch.directionsUrl).toContain('https://www.google.com/maps/dir/?api=1');
        expect(branch.directionsUrl).toContain('travelmode=driving');
        // Origin is intentionally omitted so Google Maps shows
        // "Your Location" as the start, resolved at click time.
        expect(branch.directionsUrl).not.toContain('origin=');
        // Destination is the address text, not lat/lon — Maps geocodes
        // "56 Rothschild Blvd, Tel Aviv, Israel" to the real street.
        expect(branch.directionsUrl).toContain(
            `destination=${encodeURIComponent('56 Rothschild Blvd, Tel Aviv, Israel')}`,
        );
    });

    it('omits origin from directions URLs even when user coords are absent', async () => {
        const result = await findNearestBranches(
            {},
            { requestMeta: {} },
            { fetchBranches: async () => FIXTURE_BRANCHES, now: WED_AT_NOON_LOCAL },
        );
        const branch = result.structuredContent.branches[0];
        expect(branch.directionsUrl).not.toContain('origin=');
    });

    it('clamps limit to the [1, 10] range', async () => {
        const big = await findNearestBranches(
            { limit: 999 },
            { requestMeta: { 'openai/userLocation': USER_LOC_TA } },
            { fetchBranches: async () => FIXTURE_BRANCHES, now: WED_AT_NOON_LOCAL },
        );
        // Only 3 open branches in the fixture; clamp to fixture size.
        expect(big.structuredContent.branches.length).toBeLessThanOrEqual(10);

        const tiny = await findNearestBranches(
            { limit: -5 },
            { requestMeta: { 'openai/userLocation': USER_LOC_TA } },
            { fetchBranches: async () => FIXTURE_BRANCHES, now: WED_AT_NOON_LOCAL },
        );
        expect(tiny.structuredContent.branches).toHaveLength(1);
    });

    it('builds a model-friendly content summary including the closest branch', async () => {
        const result = await findNearestBranches(
            {},
            { requestMeta: { 'openai/userLocation': USER_LOC_TA } },
            { fetchBranches: async () => FIXTURE_BRANCHES, now: WED_AT_NOON_LOCAL },
        );
        expect(result.content[0].text).toMatch(/nearest open/);
        expect(result.content[0].text).toMatch(/Tel Aviv/);
        expect(result.content[0].text).toMatch(/km/);
    });
});
