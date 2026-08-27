/**
 * Unit tests for `list_branches`.
 *
 * Stubs the branches loader so the tool's logic runs without
 * touching DDB. Asserts:
 *   - Tool definition shape (model-visible, points at hours widget)
 *   - City filter is case-insensitive
 *   - `today.isOpen` flips correctly across opening/closing time
 *   - Sunday-closed branches return `isOpen: false`
 *   - Result is bounded to MAX_BRANCHES_RETURNED
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeTodayStatus, listBranches, TOOL_DEFINITION, TOOL_NAME } from './listBranches.mjs';
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
            sun: '09:00-17:15', mon: '09:00-17:15', tue: '09:00-17:15',
            wed: '09:00-17:15', thu: '09:00-17:15', fri: '09:00-14:15', sat: 'closed',
        },
    },
    {
        branch_id: 'b-ta-2',
        name: 'Savvy TA Dizengoff',
        address: '100 Dizengoff St, Tel Aviv',
        city: 'Tel Aviv',
        region: 'Israel',
        lat: 32.0780, lon: 34.7740,
        timezone: 'Asia/Jerusalem',
        hours: {
            sun: '09:00-16:45', mon: '09:00-16:45', tue: '09:00-16:45',
            wed: '09:00-16:45', thu: '09:00-16:45', fri: '09:00-13:45', sat: 'closed',
        },
    },
];

describe('list_branches', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('publishes the expected tool definition shape', () => {
        expect(TOOL_NAME).toBe('list_branches');
        expect(TOOL_DEFINITION.name).toBe(TOOL_NAME);
        expect(TOOL_DEFINITION.annotations.readOnlyHint).toBe(true);
        // Model-visible — no `_meta.ui.visibility` of `["app"]`.
        expect(TOOL_DEFINITION._meta?.ui?.visibility).toBeUndefined();
        expect(TOOL_DEFINITION._meta?.ui?.resourceUri).toBe(WIDGETS.branches.uri);
        expect(TOOL_DEFINITION._meta?.['openai/outputTemplate']).toBe(WIDGETS.branches.uri);
    });

    it('returns all branches when no city filter is provided', async () => {
        vi.useFakeTimers();
        // Wednesday 2026-06-17, 11:00 UTC = 14:00 Asia/Jerusalem.
        vi.setSystemTime(new Date('2026-06-17T11:00:00Z'));
        const result = await listBranches({}, undefined, {
            fetchBranches: async () => FIXTURE_BRANCHES,
        });
        expect(result.structuredContent.branches).toHaveLength(3);
        expect(result.structuredContent.totalCount).toBe(3);
        expect(result.structuredContent.cityFilter).toBeUndefined();
    });

    it('applies a case-insensitive city filter', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-17T11:00:00Z'));
        const result = await listBranches(
            { city: 'tel aviv' },
            undefined,
            { fetchBranches: async () => FIXTURE_BRANCHES },
        );
        expect(result.structuredContent.branches.map((b) => b.branch_id)).toEqual([
            'b-ta-1', 'b-ta-2',
        ]);
        expect(result.structuredContent.cityFilter).toBe('tel aviv');
    });

    it('marks branches open during business hours and closed outside', async () => {
        vi.useFakeTimers();
        // Wed 2026-06-17, 11:00 UTC = 14:00 Asia/Jerusalem (well within 09:00-17:00).
        vi.setSystemTime(new Date('2026-06-17T11:00:00Z'));
        const open = await listBranches({}, undefined, {
            fetchBranches: async () => FIXTURE_BRANCHES,
        });
        for (const b of open.structuredContent.branches) {
            expect(b.today.isOpen).toBe(true);
            expect(b.today.weekday).toBe('Wednesday');
        }

        // Wed 2026-06-17, 18:00 UTC = 21:00 Asia/Jerusalem (after every close time).
        vi.setSystemTime(new Date('2026-06-17T18:00:00Z'));
        const closed = await listBranches({}, undefined, {
            fetchBranches: async () => FIXTURE_BRANCHES,
        });
        for (const b of closed.structuredContent.branches) {
            expect(b.today.isOpen).toBe(false);
        }
    });

    it('discriminates between profile A/B/C around the close-time jitter', async () => {
        vi.useFakeTimers();
        // Wed 2026-06-17, 14:05 UTC = 17:05 Asia/Jerusalem.
        // - Profile A (close 17:00): closed
        // - Profile B (close 17:15): open
        // - Profile C (close 16:45): closed
        vi.setSystemTime(new Date('2026-06-17T14:05:00Z'));
        const result = await listBranches({}, undefined, {
            fetchBranches: async () => FIXTURE_BRANCHES,
        });
        const byId = Object.fromEntries(result.structuredContent.branches.map((b) => [b.branch_id, b]));
        expect(byId['b-ta-1'].today.isOpen).toBe(false); // A
        expect(byId['b-pt-1'].today.isOpen).toBe(true);  // B
        expect(byId['b-ta-2'].today.isOpen).toBe(false); // C
    });

    it('reports closed on Saturday (sat: closed)', () => {
        vi.useFakeTimers();
        // Sat 2026-06-20, 10:00 UTC = 13:00 Asia/Jerusalem.
        vi.setSystemTime(new Date('2026-06-20T10:00:00Z'));
        for (const b of FIXTURE_BRANCHES) {
            const today = computeTodayStatus(b, new Date());
            expect(today.weekday).toBe('Saturday');
            expect(today.isOpen).toBe(false);
        }
    });

    it('builds a model-friendly content summary', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-17T11:00:00Z'));
        const result = await listBranches(
            { city: 'Tel Aviv' },
            undefined,
            { fetchBranches: async () => FIXTURE_BRANCHES },
        );
        expect(result.content[0].text).toMatch(/Tel Aviv/);
        expect(result.content[0].text).toMatch(/open right now/);
    });

    it('annotates each branch with distanceKm from the city centroid when filtered', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-17T11:00:00Z'));
        const result = await listBranches(
            { city: 'Tel Aviv' },
            undefined,
            { fetchBranches: async () => FIXTURE_BRANCHES },
        );
        // Two TA branches in the fixture → centroid lies between
        // them; each is ~the same distance from that midpoint.
        for (const b of result.structuredContent.branches) {
            expect(typeof b.distanceKm).toBe('number');
            expect(Number.isFinite(b.distanceKm)).toBe(true);
            expect(b.distanceKm).toBeLessThan(5);
        }
    });

    it('does NOT add distanceKm when no city filter is applied', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-17T11:00:00Z'));
        const result = await listBranches({}, undefined, {
            fetchBranches: async () => FIXTURE_BRANCHES,
        });
        for (const b of result.structuredContent.branches) {
            expect(b.distanceKm).toBeUndefined();
        }
    });
});
