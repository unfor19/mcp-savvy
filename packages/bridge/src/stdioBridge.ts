/**
 * stdio ↔ Streamable-HTTP MCP bridge.
 *
 * Pumps JSON-RPC messages verbatim between the local MCP host (over
 * stdio, the way an MCP client like Kiro spawns us) and the remote
 * Streamable-HTTP MCP endpoint, attaching a Bearer JWT on every
 * outbound request. On a 401 from the remote, we drop the cached
 * token, refresh once, and reconnect.
 */

import type { Logger } from '@mcp-savvy/core';
import { McpSavvyError, AuthError } from '@mcp-savvy/core';
import { isJSONRPCRequest, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BRIDGE_ERROR_CODES, categorizeBridgeError, type BridgeErrorCategory } from './bridgeErrors.js';
import {
    defaultRemoteTransport,
    errorStatus,
    type RemoteTransportFactory,
} from './remoteTransport.js';
import type { StdioBridgeOptions, TokenProvider } from './types.js';
import {
    passThroughInterceptor,
    type ResponseInterceptor,
} from './interceptors/response.js';
import {
    passThroughRequestInterceptor,
    type RequestInterceptor,
} from './interceptors/request.js';
import {
    dispatchResponse,
    type JsonRpcId,
    type PendingRequest,
} from './interceptors/responseDispatch.js';
import { dispatchRequest } from './interceptors/requestDispatch.js';

/** Factory for the stdio (host-side) transport. Tests override. */
export type StdioTransportFactory = () => Transport;

/**
 * Internal options that include test seams. Public consumers use
 * `StdioBridgeOptions`; tests call the constructor directly with a
 * scripted factory pair.
 */
export interface StdioBridgeInternalOptions extends StdioBridgeOptions {
    /** Override the host-side transport factory. */
    stdioTransport?: StdioTransportFactory;
    /** Override the remote-side transport factory. */
    remoteTransport?: RemoteTransportFactory;
}

const DEFAULT_MAX_REAUTH = 1;
const DEFAULT_MAX_INTERCEPTOR_RETRIES = 1;

/**
 * Bidirectional MCP transport pump. Construct, then `await run()`.
 * Resolves when the host (stdio) transport closes; rejects on
 * unrecoverable errors.
 */
export class StdioBridge {
    private readonly remoteUrl: string;
    private readonly getAccessToken: TokenProvider;
    private readonly logger: Logger | undefined;
    private readonly maxReauthAttempts: number;
    private readonly stdioFactory: StdioTransportFactory;
    private readonly remoteFactory: RemoteTransportFactory;
    private readonly responseInterceptor: ResponseInterceptor;
    private readonly requestInterceptor: RequestInterceptor;
    private readonly maxInterceptorRetries: number;
    private readonly pending = new Map<JsonRpcId, PendingRequest>();
    private host: Transport | null = null;
    private remote: Transport | null = null;
    private reauthAttempts = 0;
    private closed = false;

    constructor(opts: StdioBridgeInternalOptions) {
        this.remoteUrl = opts.remoteUrl;
        this.getAccessToken = opts.getAccessToken;
        this.logger = opts.logger;
        this.maxReauthAttempts = opts.maxReauthAttempts ?? DEFAULT_MAX_REAUTH;
        this.stdioFactory = opts.stdioTransport ?? (() => new StdioServerTransport());
        this.remoteFactory =
            opts.remoteTransport ??
            defaultRemoteTransport(this.remoteUrl, opts.mcpProtocolVersion);
        this.responseInterceptor = opts.responseInterceptor ?? passThroughInterceptor;
        this.requestInterceptor = opts.requestInterceptor ?? passThroughRequestInterceptor;
        this.maxInterceptorRetries =
            opts.maxInterceptorRetries ?? DEFAULT_MAX_INTERCEPTOR_RETRIES;
    }

    /**
     * Run the bridge. Resolves when the host transport closes.
     * Re-authenticates and reconnects up to `maxReauthAttempts` times
     * on 401.
     */
    async run(): Promise<void> {
        const closed = new Promise<void>((resolve) => {
            this.host = this.stdioFactory();
            this.host.onclose = () => {
                this.closed = true;
                resolve();
            };
            this.host.onerror = (err) => this.logger?.error(`stdio error: ${err.message}`);
            this.host.onmessage = (msg) => this.forwardToRemote(msg as JSONRPCMessage);
        });
        await this.connectRemote({ forceRefresh: false });
        await this.host?.start();
        await closed;
        await this.shutdown();
    }

    /** Open a fresh remote transport with a current access token. */
    private async connectRemote(input: { forceRefresh: boolean }): Promise<void> {
        const token = await this.getAccessToken(input);
        const remote = this.remoteFactory(token);
        remote.onclose = () => {
            // If the host is still up, treat unsolicited remote close as
            // a transient failure: cycle through one re-auth attempt.
            if (!this.closed) this.handleRemoteClose();
        };
        remote.onerror = (err) => this.handleRemoteError(err);
        remote.onmessage = (msg) => this.forwardToHost(msg as JSONRPCMessage);
        await remote.start();
        this.remote = remote;
        this.logger?.debug('remote transport connected');
    }

    private async forwardToRemote(msg: JSONRPCMessage): Promise<void> {
        if (!this.remote) return;
        // Run the request interceptor first. It may rewrite the
        // outbound frame (e.g. translate a synthetic tool name into
        // a real one) or swallow the request entirely and respond
        // locally (e.g. answer `tools/list` from a cached schema
        // set). On `swallow` we must not send anything to the
        // remote, but we MUST also not cache the request — there's
        // no remote response coming.
        const outcome = await dispatchRequest({
            request: msg,
            interceptor: this.requestInterceptor,
            callbacks: {
                sendToHost: (out) => this.sendToHost(out),
                sendToRemote: (out) => this.sendToRemote(out),
            },
            logger: this.logger,
        });
        if (outcome.kind === 'swallow') return;
        await this.sendToRemote(outcome.outbound);
    }

    /**
     * Direct send to the remote, bypassing the request interceptor.
     * Used by the response dispatcher's retry path (where the
     * cached `entry.request` is already the post-interception
     * form), and by the request dispatcher when it produced a
     * `replace` action. Caching the request id here is what makes
     * 3LO retry replay the right frame in `search-first` mode:
     * what we cache is what eventually gets resent.
     */
    private async sendToRemote(msg: JSONRPCMessage): Promise<void> {
        if (!this.remote) return;
        // Cache id'd requests so the response interceptor can correlate
        // a remote response with the host request that triggered it.
        // Notifications and responses are not cached. Don't overwrite
        // an existing entry — that path is used to replay an already
        // tracked request on `{ kind: 'retry' }`, where the retry
        // counter must survive the second send.
        if (isJSONRPCRequest(msg) && !this.pending.has(msg.id)) {
            this.pending.set(msg.id, { request: msg, retries: 0 });
        }
        try {
            await this.remote.send(msg);
        } catch (err) {
            this.handleRemoteError(err as Error);
        }
    }

    private forwardToHost(msg: JSONRPCMessage): void {
        if (!this.host || this.closed) return;
        void dispatchResponse({
            response: msg,
            pending: this.pending,
            interceptor: this.responseInterceptor,
            maxRetries: this.maxInterceptorRetries,
            callbacks: {
                sendToHost: (out) => this.sendToHost(out),
                sendToRemote: (req) => this.sendToRemote(req),
            },
            logger: this.logger,
        });
    }

    private sendToHost(msg: JSONRPCMessage): void {
        if (!this.host || this.closed) return;
        // Errors here surface via host.onerror; we don't await.
        void this.host.send(msg);
    }

    private async handleRemoteClose(): Promise<void> {
        if (this.closed) return;
        if (this.reauthAttempts >= this.maxReauthAttempts) {
            this.logger?.error('remote closed; reauth budget exhausted');
            await this.failHost(
                new McpSavvyError(
                    'BRIDGE_TRANSPORT_ERROR',
                    'remote closed and reauth attempts exhausted',
                ),
            );
            return;
        }
        this.reauthAttempts += 1;
        this.logger?.warn(
            `remote closed; reconnecting with fresh token (attempt ${this.reauthAttempts})`,
        );
        try {
            await this.connectRemote({ forceRefresh: true });
        } catch (err) {
            await this.failHost(err as Error);
        }
    }

    private async handleRemoteError(err: Error): Promise<void> {
        const status = errorStatus(err);
        if (status === 401 && this.reauthAttempts < this.maxReauthAttempts) {
            this.reauthAttempts += 1;
            this.logger?.warn(
                `remote returned 401; reconnecting (attempt ${this.reauthAttempts})`,
            );
            try {
                await this.remote?.close();
                await this.connectRemote({ forceRefresh: true });
                return;
            } catch (reconnectErr) {
                await this.failHost(reconnectErr as Error);
                return;
            }
        }
        this.logger?.error(`remote error: ${err.message}`);
        await this.failHost(
            err instanceof AuthError || err instanceof McpSavvyError
                ? err
                : new McpSavvyError('BRIDGE_TRANSPORT_ERROR', err.message, err),
        );
    }

    /** Emit a JSON-RPC error frame per in-flight id and drop each from `pending` (Req 5.1–5.5, 5.8). */
    private async flushPendingAsErrors(err: Error, category: BridgeErrorCategory): Promise<void> {
        if (this.closed || !this.host) return;
        const error = { code: BRIDGE_ERROR_CODES[category], message: err.message, data: { category, cause: err.name } };
        for (const id of [...this.pending.keys()]) {
            try {
                await this.host.send({ jsonrpc: '2.0', id, error });
            } catch (sendErr) {
                this.logger?.warn(`error-frame send failed: ${(sendErr as Error).message}`);
            }
            this.pending.delete(id);
        }
    }

    private async failHost(err: Error): Promise<void> {
        this.logger?.error(`bridge failing: ${err.message}`);
        await this.flushPendingAsErrors(err, categorizeBridgeError(err));
        await this.shutdown();
    }

    /** Best-effort close of both transports; idempotent and safe to call from external cleanup. */
    async shutdown(): Promise<void> {
        const host = this.host;
        const remote = this.remote;
        this.host = null;
        this.remote = null;
        // Best-effort close both sides; ignore errors during teardown.
        await Promise.allSettled([
            host ? host.close() : Promise.resolve(),
            remote ? remote.close() : Promise.resolve(),
        ]);
    }
}
