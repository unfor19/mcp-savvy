/** Spatial layout for the Pattern D animation — left-to-right flow on a 1920×1080 canvas. */

import { sizes } from './theme';

/** A single architecture component placed on the canvas. */
export interface Node {
    /** Stable ID (referenced by edges + flow paths). */
    readonly id: string;
    /** Centre x (px). */
    readonly cx: number;
    /** Centre y (px). */
    readonly cy: number;
    /** Card width (defaults to `sizes.cardWidth`). */
    readonly w?: number;
    /** Card height (defaults to `sizes.cardHeight`). */
    readonly h?: number;
}

/** Architecture component positions. */
export const nodes = {
    client: { id: 'client', cx: 200, cy: 540, w: 320, h: 130 },
    cognito: { id: 'cognito', cx: 820, cy: 170, w: 320, h: 130 },
    apigw: { id: 'apigw', cx: 820, cy: 560, w: 480, h: 360 },
    lambda: { id: 'lambda', cx: 1280, cy: 540, w: 280, h: 110 },
    ddbCustomer: { id: 'ddbCustomer', cx: 1640, cy: 380, w: 280, h: 96 },
    ddbRefs: { id: 'ddbRefs', cx: 1640, cy: 540, w: 280, h: 96 },
    ddbAudit: { id: 'ddbAudit', cx: 1640, cy: 700, w: 280, h: 96 },
} satisfies Record<string, Node>;

/** Bounds of the VPC region (rounded rectangle drawn behind Lambda + DDB tables). */
export const vpcBox = {
    x: 1100,
    y: 240,
    w: 720,
    h: 600,
    /** Where the request enters the VPC (left edge midpoint). */
    entryX: 1100,
    entryY: 540,
} as const;

/** A flow path is a polyline between nodes that a packet travels along. */
export interface Path {
    /** Stable ID. */
    readonly id: string;
    /** Ordered waypoints (centre coords). */
    readonly waypoints: ReadonlyArray<readonly [number, number]>;
    /** Label rendered near the path while packet is in flight. */
    readonly label?: string;
}

const c = (n: Node): readonly [number, number] => [n.cx, n.cy];
const topEdge = (n: Node): readonly [number, number] => [n.cx, n.cy - (n.h ?? sizes.cardHeight) / 2];
const bottomEdge = (n: Node): readonly [number, number] => [n.cx, n.cy + (n.h ?? sizes.cardHeight) / 2];
const rightEdge = (n: Node): readonly [number, number] => [n.cx + (n.w ?? sizes.cardWidth) / 2, n.cy];
const leftEdge = (n: Node): readonly [number, number] => [n.cx - (n.w ?? sizes.cardWidth) / 2, n.cy];

/** Pre-built flow paths for each animated phase. */
export const paths = {
    oauth: {
        id: 'oauth',
        label: 'OAuth 2.1 + PKCE → access_token',
        waypoints: [
            c(nodes.client),
            [nodes.client.cx, nodes.cognito.cy],
            leftEdge(nodes.cognito),
            c(nodes.cognito),
            leftEdge(nodes.cognito),
            [nodes.client.cx, nodes.cognito.cy],
            c(nodes.client),
        ],
    },
    request: {
        id: 'request',
        label: 'POST /mcp · Authorization: Bearer JWT',
        waypoints: [c(nodes.client), rightEdge(nodes.client), leftEdge(nodes.apigw), c(nodes.apigw)],
    },
    jwks: {
        id: 'jwks',
        label: 'verify JWT signature · /.well-known/jwks.json',
        waypoints: [
            c(nodes.apigw),
            topEdge(nodes.apigw),
            [nodes.apigw.cx, nodes.cognito.cy + (nodes.cognito.h ?? sizes.cardHeight) / 2],
            bottomEdge(nodes.cognito),
            c(nodes.cognito),
            bottomEdge(nodes.cognito),
            topEdge(nodes.apigw),
            c(nodes.apigw),
        ],
    },
    forwardToLambda: {
        id: 'forwardToLambda',
        label: 'authenticated · proxy integration → Lambda',
        waypoints: [
            c(nodes.apigw),
            rightEdge(nodes.apigw),
            [vpcBox.entryX, nodes.apigw.cy],
            leftEdge(nodes.lambda),
            c(nodes.lambda),
        ],
    },
    ddbRead: {
        id: 'ddbRead',
        label: 'GetItem customer_data · via DynamoDB Gateway VPCE',
        waypoints: [
            c(nodes.lambda),
            rightEdge(nodes.lambda),
            [(nodes.lambda.cx + nodes.ddbCustomer.cx) / 2, nodes.lambda.cy],
            [(nodes.lambda.cx + nodes.ddbCustomer.cx) / 2, nodes.ddbCustomer.cy],
            leftEdge(nodes.ddbCustomer),
            c(nodes.ddbCustomer),
        ],
    },
    refsMint: {
        id: 'refsMint',
        label: 'PutItem secure_view_refs · 60s TTL · single-use',
        waypoints: [
            c(nodes.lambda),
            rightEdge(nodes.lambda),
            leftEdge(nodes.ddbRefs),
            c(nodes.ddbRefs),
        ],
    },
    auditWrite: {
        id: 'auditWrite',
        label: 'PutItem audit_log · append-only',
        waypoints: [
            c(nodes.lambda),
            rightEdge(nodes.lambda),
            [(nodes.lambda.cx + nodes.ddbAudit.cx) / 2, nodes.lambda.cy],
            [(nodes.lambda.cx + nodes.ddbAudit.cx) / 2, nodes.ddbAudit.cy],
            leftEdge(nodes.ddbAudit),
            c(nodes.ddbAudit),
        ],
    },
    response: {
        id: 'response',
        label: '200 · structuredContent + _meta.secure_view_ref',
        waypoints: [
            c(nodes.lambda),
            leftEdge(nodes.lambda),
            [vpcBox.entryX, nodes.apigw.cy],
            rightEdge(nodes.apigw),
            c(nodes.apigw),
            leftEdge(nodes.apigw),
            rightEdge(nodes.client),
            c(nodes.client),
        ],
    },
} satisfies Record<string, Path>;

/** Subset of paths drawn in the always-visible static dashed layer. */
export const STATIC_PATH_IDS = ['oauth', 'request', 'jwks', 'forwardToLambda', 'ddbRead', 'refsMint', 'auditWrite'] as const;

/** Total polyline length, used to normalise progress 0..1 → distance along path. */
export function pathLength(path: Path): number {
    let total = 0;
    for (let i = 1; i < path.waypoints.length; i++) {
        const a = path.waypoints[i - 1]!;
        const b = path.waypoints[i]!;
        total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return total;
}

/** Position along a polyline at progress `t` ∈ [0, 1]. */
export function pointAt(path: Path, t: number): readonly [number, number] {
    const total = pathLength(path);
    const want = Math.max(0, Math.min(1, t)) * total;
    let consumed = 0;
    for (let i = 1; i < path.waypoints.length; i++) {
        const a = path.waypoints[i - 1]!;
        const b = path.waypoints[i]!;
        const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (consumed + seg >= want) {
            const local = (want - consumed) / (seg || 1);
            return [a[0] + (b[0] - a[0]) * local, a[1] + (b[1] - a[1]) * local];
        }
        consumed += seg;
    }
    return path.waypoints[path.waypoints.length - 1]!;
}

/** Flatten a polyline into an SVG `M … L … L …` path string. */
export function svgPath(path: Path): string {
    const [first, ...rest] = path.waypoints;
    if (!first) return '';
    return [`M ${first[0]} ${first[1]}`, ...rest.map(([x, y]) => `L ${x} ${y}`)].join(' ');
}
