/**
 * `list_branches` — public, model-visible tool.
 *
 * Lists Savvy branches, optionally filtered by city. Each row
 * carries today's open/closed status computed server-side from
 * the branch's local timezone (`Asia/Jerusalem` for the demo).
 *
 * Non-sensitive data: returned in `structuredContent` so the
 * model can answer textual queries ("which Tel Aviv branch
 * closes latest?"), and pointed at a widget via
 * `_meta.ui.resourceUri` so the host renders a card.
 *
 * No DDB writes, no audit log noise — branches are public.
 */

import { listBranches as listBranchesFromDdb } from '../dynamo.mjs';
import { WIDGETS } from '../widgetUri.mjs';
import { centroidOf, haversineKm } from './geo.mjs';

export const TOOL_NAME = 'list_branches';

const MAX_BRANCHES_RETURNED = 50;

export const TOOL_DEFINITION = Object.freeze({
    name: TOOL_NAME,
    title: 'List Savvy branches',
    description:
        'Lists Savvy branches with today\'s open/closed status. Optionally filter ' +
        'by city (e.g. "Tel Aviv", "Petah Tikva"). Public information; safe to ' +
        'surface in chat.',
    inputSchema: {
        type: 'object',
        properties: {
            city: {
                type: 'string',
                description:
                    'Optional case-insensitive city filter. When omitted, all branches are returned.',
            },
        },
        additionalProperties: false,
    },
    outputSchema: {
        type: 'object',
        properties: {
            branches: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        branch_id: { type: 'string' },
                        name: { type: 'string' },
                        address: { type: 'string' },
                        city: { type: 'string' },
                        lat: { type: 'number' },
                        lon: { type: 'number' },
                        timezone: { type: 'string' },
                        today: {
                            type: 'object',
                            properties: {
                                weekday: { type: 'string' },
                                isOpen: { type: 'boolean' },
                                opensAt: { type: 'string' },
                                closesAt: { type: 'string' },
                            },
                            required: ['weekday', 'isOpen'],
                        },
                    },
                    required: ['branch_id', 'name', 'city', 'today'],
                },
            },
            totalCount: { type: 'number' },
            cityFilter: { type: 'string' },
        },
        required: ['branches', 'totalCount'],
        additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
        ui: { resourceUri: WIDGETS.branches.uri },
        'openai/outputTemplate': WIDGETS.branches.uri,
        'openai/toolInvocation/invoking': 'Looking up branches…',
        'openai/toolInvocation/invoked': 'Branches ready',
    },
});

/**
 * Run the tool. Optional `args.city` narrows the result. When a
 * city filter is applied, each result also carries a
 * `distanceKm` from the centroid of the filtered branches — a
 * useful "intra-city" distance for picking the closest branch
 * within a city. Without a filter, no distance is computed
 * (use `find_nearest_branches` for system-location ranking).
 *
 * Always returns at most `MAX_BRANCHES_RETURNED` rows; ChatGPT
 * renders a scrollable card so 50 is fine, and the cap defends
 * against a future scenario where the table grows.
 */
export async function listBranches(args, _context, deps = {}) {
    const cityArg = typeof args?.city === 'string' ? args.city.trim() : '';
    const now = deps.now ?? new Date();
    const all = await (deps.fetchBranches ?? listBranchesFromDdb)();
    const filtered = cityArg
        ? all.filter((b) => typeof b.city === 'string' && b.city.toLowerCase() === cityArg.toLowerCase())
        : all;
    // Centroid of the filtered branches gives a reasonable "city
    // centre" reference for intra-city distances. Skip when the
    // filter has 0 or 1 branch — the centroid would just be the
    // single branch (zero distance).
    const origin = (cityArg && filtered.length >= 2) ? centroidOf(filtered) : null;
    const enriched = filtered.slice(0, MAX_BRANCHES_RETURNED).map((b) => {
        const lat = typeof b.lat === 'number' ? b.lat : 0;
        const lon = typeof b.lon === 'number' ? b.lon : 0;
        const distanceKm = origin ? haversineKm(origin, { lat, lon }) : undefined;
        return {
            branch_id: b.branch_id,
            name: b.name,
            address: b.address ?? '',
            city: b.city,
            lat,
            lon,
            timezone: b.timezone ?? 'Asia/Jerusalem',
            today: computeTodayStatus(b, now),
            ...(distanceKm !== undefined ? { distanceKm } : {}),
        };
    });
    const summary = buildSummaryText(enriched, cityArg, filtered.length);
    return {
        structuredContent: {
            branches: enriched,
            totalCount: filtered.length,
            ...(cityArg ? { cityFilter: cityArg } : {}),
        },
        content: [{ type: 'text', text: summary }],
        _meta: {
            ui: { resourceUri: WIDGETS.branches.uri },
            'openai/outputTemplate': WIDGETS.branches.uri,
        },
    };
}

/** Compute the branch's open/closed status in its local timezone. */
export function computeTodayStatus(branch, now) {
    const tz = branch.timezone || 'Asia/Jerusalem';
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'long',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    const minuteOfDay = hour * 60 + minute;
    const dayKey = weekday.toLowerCase().slice(0, 3);
    const slot = branch.hours?.[dayKey];
    if (!slot || slot === 'closed') return { weekday, isOpen: false };
    const [opensAt, closesAt] = String(slot).split('-');
    if (!opensAt || !closesAt) return { weekday, isOpen: false };
    const open = parseHm(opensAt);
    const close = parseHm(closesAt);
    const isOpen = minuteOfDay >= open && minuteOfDay < close;
    return { weekday, isOpen, opensAt, closesAt };
}

function parseHm(hm) {
    const [h, m] = hm.split(':').map((s) => Number(s));
    return h * 60 + m;
}

function buildSummaryText(branches, cityArg, totalForCity) {
    if (branches.length === 0) {
        return cityArg
            ? `No Savvy branches in ${cityArg}.`
            : 'No Savvy branches available.';
    }
    const openCount = branches.filter((b) => b.today.isOpen).length;
    const where = cityArg ? `in ${cityArg}` : 'across Israel';
    const more = totalForCity > branches.length ? ` (showing ${branches.length} of ${totalForCity})` : '';
    return `${branches.length} Savvy ${branches.length === 1 ? 'branch' : 'branches'} ${where}${more}; ${openCount} open right now.`;
}
