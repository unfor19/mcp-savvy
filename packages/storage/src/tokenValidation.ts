/**
 * Runtime validation for the existing persisted token representation.
 */

import type { TokenData } from '@mcp-savvy/core';

/** Return whether an unknown value is a structurally valid `TokenData` bundle. */
export function isTokenData(value: unknown): value is TokenData {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.access_token === 'string' &&
        candidate.access_token.length > 0 &&
        typeof candidate.expires_at === 'number' &&
        Number.isFinite(candidate.expires_at) &&
        isOptionalString(candidate.refresh_token) &&
        isOptionalString(candidate.id_token)
    );
}

function isOptionalString(value: unknown): boolean {
    return value === undefined || typeof value === 'string';
}
