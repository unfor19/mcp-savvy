/**
 * `find_nearest_branches` — public, model-visible tool.
 *
 * Reads the user's coarse location from `_meta["openai/userLocation"]`
 * (auto-provided by ChatGPT on every tool call) and ranks open
 * branches by straight-line (Haversine) distance. Returns the top
 * N results with a per-branch directions URL.
 *
 * Each `directionsUrl` is a free Google Maps link with both an
 * `origin=lat,lon` and `destination=lat,lon` parameter, so when
 * the user clicks it Google Maps opens with turn-by-turn driving
 * directions, real-time traffic, and ETA — no Maps API key, no
 * NAT, no quota. Maps does its own geolocation in the destination
 * tab, separate from the ChatGPT iframe sandbox.
 *
 * Fallback: when `_meta["openai/userLocation"]` is missing (the
 * user disabled location sharing in ChatGPT settings), returns a
 * city-sorted list without distance ranking. The widget renders
 * the same shape either way; the response includes
 * `usedFallback: true` so the model can adjust its narration.
 */

import { listBranches as listBranchesFromDdb } from '../dynamo.mjs';
import { WIDGETS } from '../widgetUri.mjs';
import { computeTodayStatus } from './listBranches.mjs';
import { centroidOf, haversineKm } from './geo.mjs';

export const TOOL_NAME = 'find_nearest_branches';

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 10;

export const TOOL_DEFINITION = Object.freeze({
    name: TOOL_NAME,
    title: 'Find nearest Savvy branches',
    description:
        'Ranks Savvy branches by straight-line distance to the user\'s current location ' +
        '(read from system metadata; never asked for as input). Returns the top N open ' +
        'branches with a Google Maps directions link per result. Use when the user asks ' +
        '"closest branch", "nearest", or "near me". Falls back to a city list when the ' +
        'user has location sharing disabled.',
    inputSchema: {
        type: 'object',
        properties: {
            mustBeOpen: {
                type: 'boolean',
                description:
                    'When true (default), only branches open right now are considered. ' +
                    'Set false to rank closed branches too (e.g. "where\'s the closest one for tomorrow?").',
            },
            limit: {
                type: 'number',
                description: `Number of branches to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
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
                        today: { type: 'object' },
                        distanceKm: { type: 'number' },
                        directionsUrl: { type: 'string' },
                    },
                    required: ['branch_id', 'name', 'today', 'directionsUrl'],
                },
            },
            userCity: { type: 'string' },
            usedFallback: {
                type: 'boolean',
                description: 'True when the user\'s location wasn\'t available and city-sort fallback was used.',
            },
        },
        required: ['branches'],
        additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
        ui: { resourceUri: WIDGETS.branches.uri },
        'openai/outputTemplate': WIDGETS.branches.uri,
        'openai/toolInvocation/invoking': 'Finding nearest branches…',
        'openai/toolInvocation/invoked': 'Nearest branches ready',
    },
});

/**
 * Run the tool. `context.requestMeta` carries the request's
 * JSON-RPC `_meta`, where ChatGPT places `openai/userLocation`.
 * Test deps: `fetchBranches` (DDB stub), `now` (frozen clock).
 */
export async function findNearestBranches(args, context, deps = {}) {
    const mustBeOpen = args?.mustBeOpen !== false;
    const limit = clampLimit(args?.limit);
    const userLoc = context?.requestMeta?.['openai/userLocation'];
    const now = deps.now ?? new Date();
    const all = await (deps.fetchBranches ?? listBranchesFromDdb)();

    const candidates = mustBeOpen
        ? all.filter((b) => computeTodayStatus(b, now).isOpen)
        : all;

    // Pick the origin point for distance ranking. Two acceptable
    // sources, in priority order:
    //   1. ChatGPT's `_meta["openai/userLocation"]` carries explicit
    //      `latitude` + `longitude` — best precision.
    //   2. Same `_meta` block carries only `city` (some users have
    //      privacy settings that strip coords) — synthesise an
    //      origin from the centroid of branches in that city.
    // Otherwise fall back to a city-sorted list with no ranking.
    const origin = pickOrigin(userLoc, all);
    if (!origin) {
        return fallbackResponse(candidates, now, limit, userLoc);
    }

    const ranked = candidates
        .map((b) => ({
            ...buildBranchPayload(b, now),
            distanceKm: haversineKm(origin, { lat: b.lat, lon: b.lon }),
        }))
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, limit);

    return successResponse(ranked, userLoc);
}

/**
 * Resolve the best origin for distance ranking from the
 * user-location hint. Returns `null` when neither coords nor a
 * recognisable city are available.
 */
function pickOrigin(userLoc, allBranches) {
    if (typeof userLoc?.latitude === 'number' && typeof userLoc?.longitude === 'number') {
        return { lat: userLoc.latitude, lon: userLoc.longitude };
    }
    if (typeof userLoc?.city === 'string' && userLoc.city.trim()) {
        const cityName = userLoc.city.trim().toLowerCase();
        const cityBranches = allBranches.filter(
            (b) => typeof b.city === 'string' && b.city.toLowerCase() === cityName,
        );
        if (cityBranches.length > 0) return centroidOf(cityBranches);
    }
    return null;
}

/** Clamp the user-supplied limit to `[1, MAX_LIMIT]`. Defaults when invalid. */
function clampLimit(input) {
    if (typeof input !== 'number' || !Number.isFinite(input)) return DEFAULT_LIMIT;
    return Math.max(1, Math.min(MAX_LIMIT, Math.floor(input)));
}

/**
 * Build the model-visible branch payload, including the Google Maps
 * directions URL with the branch's address as the destination and
 * the user's device-location as the (implicit) origin.
 */
function buildBranchPayload(branch, now, _userLoc) {
    return {
        branch_id: branch.branch_id,
        name: branch.name,
        address: branch.address ?? '',
        city: branch.city,
        lat: branch.lat,
        lon: branch.lon,
        timezone: branch.timezone ?? 'Asia/Jerusalem',
        today: computeTodayStatus(branch, now),
        directionsUrl: buildDirectionsUrl(branch),
    };
}

/**
 * Build a Google Maps directions URL. Free, no API key.
 *
 * The destination is the human-readable address (with region
 * appended for disambiguation), not `lat,lon` — our fake fixtures
 * have plausible street addresses but the coordinates are
 * city-center jitter, so coord-based URLs route to random spots
 * on the street. Maps geocodes the address text reliably.
 *
 * Origin is intentionally omitted. Google Maps then defaults to
 * the device's current location ("Your Location" in the Maps UI)
 * resolved at click time. This is more reliable than:
 *   - hard-coding `_meta["openai/userLocation"]` coarse coords
 *     (often wrong city — e.g. Frankfurt for an IL user)
 *   - the literal string `current+location` (Maps may try to
 *     geocode it as a place name)
 */
function buildDirectionsUrl(branch) {
    const base = 'https://www.google.com/maps/dir/?api=1';
    const destText = branch.address
        ? (branch.region ? `${branch.address}, ${branch.region}` : branch.address)
        : `${branch.lat},${branch.lon}`;
    const dest = encodeURIComponent(destText);
    return `${base}&destination=${dest}&travelmode=driving`;
}

/** Build the success envelope for the ranked top-N. */
function successResponse(ranked, userLoc) {
    const summary = ranked.length === 0
        ? 'No open Savvy branches near you right now.'
        : `${ranked.length} nearest open ${ranked.length === 1 ? 'branch' : 'branches'} `
        + `${userLoc?.city ? `near ${userLoc.city}` : 'to your location'}; `
        + `closest is ${ranked[0].name} (~${ranked[0].distanceKm.toFixed(1)} km).`;
    return {
        structuredContent: {
            branches: ranked,
            ...(userLoc?.city ? { userCity: userLoc.city } : {}),
        },
        content: [{ type: 'text', text: summary }],
        _meta: {
            ui: { resourceUri: WIDGETS.branches.uri },
            'openai/outputTemplate': WIDGETS.branches.uri,
        },
    };
}

/** Fallback envelope when user location isn't available. */
function fallbackResponse(candidates, now, limit, userLoc) {
    const sorted = [...candidates]
        .sort((a, b) => (a.city || '').localeCompare(b.city || ''))
        .slice(0, limit)
        .map((b) => buildBranchPayload(b, now));
    const summary = candidates.length === 0
        ? 'No open Savvy branches right now.'
        : `Your location wasn't shared, so I can't rank by distance. Here are ${sorted.length} branches.`;
    return {
        structuredContent: {
            branches: sorted,
            usedFallback: true,
            ...(userLoc?.city ? { userCity: userLoc.city } : {}),
        },
        content: [{ type: 'text', text: summary }],
        _meta: {
            ui: { resourceUri: WIDGETS.branches.uri },
            'openai/outputTemplate': WIDGETS.branches.uri,
        },
    };
}
