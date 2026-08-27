/**
 * Pluggable HTTP client.
 *
 * Production code uses the `nodeFetcher` (built on Node's global `fetch`).
 * Tests inject a fake fetcher so the suite never hits the network.
 */

/** A response shape `Fetcher` produces; subset of WHATWG `Response`. */
export interface FetchResponse {
    /** HTTP status code. */
    status: number;
    /** Plain header map; lowercased keys, single values. */
    headers: Record<string, string>;
    /** Body parsed as utf-8 text. */
    body: string;
}

/** Inputs for a single request. */
export interface FetchRequest {
    method: 'GET' | 'POST';
    url: string;
    headers?: Record<string, string>;
    body?: string;
}

/**
 * Subset of HTTP we need for OIDC discovery + token exchange. All
 * concrete implementations (real fetch, fakes) implement this.
 */
export interface Fetcher {
    fetch(req: FetchRequest): Promise<FetchResponse>;
}

/** Options that bound every real HTTP response. */
export interface NodeFetcherOptions {
    /** Abort a request after this many milliseconds. */
    timeoutMs?: number;
    /** Reject a response body after this many bytes. */
    maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

/** Read a response body without allowing an unbounded allocation. */
async function readBoundedBody(res: Response, maxBytes: number): Promise<string> {
    const declaredLength = Number(res.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error(`HTTP response exceeds ${maxBytes} bytes`);
    }
    if (!res.body) return '';

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
            await reader.cancel();
            throw new Error(`HTTP response exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
    }
    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(body);
}

/** Build a `Fetcher` backed by Node's global `fetch` with bounded responses. */
export function createNodeFetcher(options: NodeFetcherOptions = {}): Fetcher {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
    if (!Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0) {
        throw new Error('maxResponseBytes must be positive');
    }
    return {
        async fetch(req: FetchRequest): Promise<FetchResponse> {
            const init: RequestInit = {
                method: req.method,
                signal: AbortSignal.timeout(timeoutMs),
            };
            if (req.headers) init.headers = req.headers;
            if (req.body !== undefined) init.body = req.body;
            const res = await fetch(req.url, init);
            const headers: Record<string, string> = {};
            res.headers.forEach((value, key) => {
                headers[key.toLowerCase()] = value;
            });
            return {
                status: res.status,
                headers,
                body: await readBoundedBody(res, maxResponseBytes),
            };
        },
    };
}

/** Default bounded `Fetcher` backed by Node's global `fetch`. */
export const nodeFetcher: Fetcher = createNodeFetcher();
