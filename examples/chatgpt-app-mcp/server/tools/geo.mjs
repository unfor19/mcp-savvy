/**
 * Geographic utilities shared by the chatgpt-app-mcp tools.
 *
 * Two tiny helpers used by both `find_nearest_branches` (rank by
 * user-location proximity) and `list_branches` (intra-city
 * distance from the centroid of the filtered branches).
 *
 * Centralised here so fon's duplicate-symbol check stays clean
 * and so the math is unit-tested through both callers' test
 * suites without a separate test file.
 */

const EARTH_RADIUS_KM = 6371;

/**
 * Haversine straight-line distance between two `(lat, lon)`
 * points, in kilometres. Both inputs must have numeric `lat` and
 * `lon`. Returns `NaN` for invalid input rather than throwing —
 * caller filters NaN out of result lists.
 */
export function haversineKm(a, b) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2
        + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * Arithmetic mean of a non-empty list of `(lat, lon)` points.
 * Returns `null` when the input has no usable points. Good
 * enough for picking a "city centre" from a handful of branch
 * coordinates — for a demo with city-jittered coords, the mean
 * IS the city centre we seeded around.
 */
export function centroidOf(points) {
    const valid = (points || []).filter(
        (p) => typeof p?.lat === 'number' && typeof p?.lon === 'number',
    );
    if (valid.length === 0) return null;
    const lat = valid.reduce((sum, p) => sum + p.lat, 0) / valid.length;
    const lon = valid.reduce((sum, p) => sum + p.lon, 0) / valid.length;
    return { lat, lon };
}
