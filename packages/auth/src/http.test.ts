/**
 * Integration tests for the default `nodeFetcher`. We hit a tiny
 * in-process HTTP server so we never depend on outbound network.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createNodeFetcher, nodeFetcher } from './http.js';

let server: Server;
let baseUrl: string;

beforeAll(
    () =>
        new Promise<void>((resolve) => {
            server = createServer((req, res) => {
                if (req.url === '/get') {
                    res.writeHead(200, { 'content-type': 'text/plain', 'x-test': 'ok' });
                    res.end('hello');
                    return;
                }
                if (req.url === '/post') {
                    let body = '';
                    req.on('data', (chunk: Buffer) => {
                        body += chunk.toString('utf8');
                    });
                    req.on('end', () => {
                        res.writeHead(201, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ method: req.method, body }));
                    });
                    return;
                }
                if (req.url === '/chunked') {
                    res.writeHead(200, { 'content-type': 'text/plain' });
                    res.write('1234');
                    res.end('5678');
                    return;
                }
                if (req.url === '/multibyte') {
                    res.writeHead(200, { 'content-type': 'text/plain' });
                    res.end('\u20ac\u20ac');
                    return;
                }
                if (req.url === '/slow') {
                    setTimeout(() => {
                        res.writeHead(200);
                        res.end('late');
                    }, 100);
                    return;
                }
                if (req.url === '/redirect') {
                    res.writeHead(302, { location: '/get' });
                    res.end();
                    return;
                }
                res.writeHead(404);
                res.end('not found');
            });
            server.listen(0, '127.0.0.1', () => {
                const port = (server.address() as AddressInfo).port;
                baseUrl = `http://127.0.0.1:${port}`;
                resolve();
            });
        }),
);

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('nodeFetcher.fetch', () => {
    it('GETs and returns status, body, and lowercased headers', async () => {
        const res = await nodeFetcher.fetch({ method: 'GET', url: `${baseUrl}/get` });
        expect(res.status).toBe(200);
        expect(res.body).toBe('hello');
        expect(res.headers['x-test']).toBe('ok');
    });

    it('POSTs a body and headers', async () => {
        const res = await nodeFetcher.fetch({
            method: 'POST',
            url: `${baseUrl}/post`,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'a=1&b=2',
        });
        expect(res.status).toBe(201);
        const parsed = JSON.parse(res.body);
        expect(parsed.method).toBe('POST');
        expect(parsed.body).toBe('a=1&b=2');
    });

    it('returns the upstream status for non-2xx responses', async () => {
        const res = await nodeFetcher.fetch({ method: 'GET', url: `${baseUrl}/missing` });
        expect(res.status).toBe(404);
        expect(res.body).toBe('not found');
    });

    it('rejects redirects instead of forwarding credential-bearing requests', async () => {
        await expect(
            nodeFetcher.fetch({ method: 'GET', url: `${baseUrl}/redirect` }),
        ).rejects.toThrow();
    });

    it('rejects a chunked body that crosses the byte limit', async () => {
        const fetcher = createNodeFetcher({ maxResponseBytes: 7 });
        await expect(fetcher.fetch({ method: 'GET', url: `${baseUrl}/chunked` })).rejects.toThrow(
            'exceeds 7 bytes',
        );
    });

    it('measures multibyte responses in bytes and accepts the exact limit', async () => {
        const exact = createNodeFetcher({ maxResponseBytes: 6 });
        await expect(exact.fetch({ method: 'GET', url: `${baseUrl}/multibyte` })).resolves.toMatchObject({
            body: '\u20ac\u20ac',
        });
        const tooSmall = createNodeFetcher({ maxResponseBytes: 5 });
        await expect(
            tooSmall.fetch({ method: 'GET', url: `${baseUrl}/multibyte` }),
        ).rejects.toThrow('exceeds 5 bytes');
    });

    it('aborts requests that exceed the deadline', async () => {
        const fetcher = createNodeFetcher({ timeoutMs: 10 });
        await expect(fetcher.fetch({ method: 'GET', url: `${baseUrl}/slow` })).rejects.toThrow();
    });
});
