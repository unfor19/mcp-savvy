/**
 * Lambda handler for `POST /complete-session`.
 *
 * Called by the bridge after the user finishes a 3LO authorization
 * flow at the third-party provider (GitHub, Slack, etc). API Gateway
 * has already validated the OIDC JWT via the Lambda authorizer; this
 * handler calls AgentCore Identity's `CompleteResourceTokenAuth`
 * with the session URI and the bearer token already authenticated by
 * which AgentCore uses to extract the `sub` claim and bind the
 * authorization session to the user).
 */

import {
    BedrockAgentCoreClient,
    CompleteResourceTokenAuthCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { createHash } from 'node:crypto';

const AUDIT_FINGERPRINT_LENGTH = 16;

const client = new BedrockAgentCoreClient({});

interface ApiGatewayProxyEvent {
    readonly headers?: Record<string, string | undefined>;
    readonly body: string | null;
    readonly requestContext?: {
        readonly requestId?: string;
        readonly authorizer?: Record<string, unknown>;
    };
}

interface ApiGatewayProxyResult {
    readonly statusCode: number;
    readonly headers: Record<string, string>;
    readonly body: string;
}

const RESPONSE_HEADERS: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

function jsonResponse(statusCode: number, body: unknown): ApiGatewayProxyResult {
    return {
        statusCode,
        headers: RESPONSE_HEADERS,
        body: JSON.stringify(body),
    };
}

interface CompleteSessionBody {
    readonly sessionUri?: unknown;
}

type AuditOutcome = 'invalid_body' | 'missing_session_uri' | 'missing_user_token' | 'success' | 'service_error';

function fingerprint(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, AUDIT_FINGERPRINT_LENGTH);
}

function audit(
    event: ApiGatewayProxyEvent,
    outcome: AuditOutcome,
    sessionUri?: string,
    errorType?: string,
): void {
    const sub = event.requestContext?.authorizer?.['sub'];
    const record: Record<string, string> = { event: 'complete_session', outcome };
    if (event.requestContext?.requestId) record['requestId'] = event.requestContext.requestId;
    if (typeof sub === 'string') record['subjectFingerprint'] = fingerprint(sub);
    if (sessionUri) record['sessionFingerprint'] = fingerprint(sessionUri);
    if (errorType) record['errorType'] = errorType;
    const serialized = JSON.stringify(record);
    if (outcome === 'service_error') console.error(serialized);
    else console.info(serialized);
}

/** Extract the bearer credential authenticated by API Gateway. */
export function bearerToken(headers: Record<string, string | undefined> | undefined): string | null {
    const value = Object.entries(headers ?? {}).find(
        ([name]) => name.toLowerCase() === 'authorization',
    )?.[1];
    const match = value?.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim() || null;
}

function parseBody(raw: string | null): CompleteSessionBody | null {
    if (!raw) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed as CompleteSessionBody;
        return null;
    } catch {
        return null;
    }
}

export const handler = async (event: ApiGatewayProxyEvent): Promise<ApiGatewayProxyResult> => {
    const body = parseBody(event.body);
    if (!body) {
        audit(event, 'invalid_body');
        return jsonResponse(400, { error: 'invalid_body', message: 'Body must be JSON.' });
    }

    const { sessionUri } = body;
    if (typeof sessionUri !== 'string' || sessionUri.length === 0) {
        audit(event, 'missing_session_uri');
        return jsonResponse(400, {
            error: 'missing_session_uri',
            message: 'sessionUri is required.',
        });
    }
    const userToken = bearerToken(event.headers);
    if (!userToken) {
        audit(event, 'missing_user_token', sessionUri);
        return jsonResponse(401, {
            error: 'missing_user_token',
            message: 'A Bearer authorization token is required.',
        });
    }

    try {
        await client.send(
            new CompleteResourceTokenAuthCommand({
                sessionUri,
                userIdentifier: { userToken },
            }),
        );
        audit(event, 'success', sessionUri);
        return jsonResponse(200, { ok: true });
    } catch (err) {
        const name = err instanceof Error ? err.name : 'UnknownError';
        // AgentCore's typed errors carry useful HTTP status mapping.
        const status =
            name === 'ValidationException' || name === 'ResourceNotFoundException'
                ? 400
                : name === 'AccessDeniedException' || name === 'UnauthorizedException'
                    ? 403
                    : name === 'ThrottlingException'
                        ? 429
                        : 500;
        audit(event, 'service_error', sessionUri, name);
        return jsonResponse(status, {
            error: status >= 500 ? 'service_error' : 'request_rejected',
            message: status >= 500 ? 'The service could not complete the request.' : 'The request was rejected.',
        });
    }
};
