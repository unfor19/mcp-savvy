/**
 * Internal contracts shared by platform-specific keychain backends.
 *
 * Backends return only safely classified local-entry outcomes. Operational
 * failures throw a sanitized `KeychainReadError` so callers fail closed.
 */

/** Safe outcomes from reading one operating-system keychain entry. */
export type KeychainReadResult =
    | { status: 'found'; value: string }
    | { status: 'missing' }
    | { status: 'unreadable-local-entry' };

/** Sanitized categories for keychain failures that must fail closed. */
export type KeychainReadFailureCategory =
    | 'permission-denied'
    | 'integrity-failure'
    | 'invocation-failure'
    | 'operational-failure';

/** Sanitized keychain read failure that never retains command error payloads. */
export class KeychainReadError extends Error {
    override readonly name = 'KeychainReadError';

    constructor(readonly category: KeychainReadFailureCategory) {
        super(`operating-system keychain read failed: ${category}`);
    }
}

/** Internal interface implemented by each platform-specific keychain backend. */
export interface KeychainBackend {
    /** Stable display name shown by the logger ("macOS Keychain", etc.). */
    readonly name: string;
    /** True if this backend can run on the current host. */
    isAvailable(): boolean;
    /** Read a safely classified local-entry outcome or throw a sanitized failure. */
    get(): KeychainReadResult;
    /** Persist `value`. Returns false on any error. */
    set(value: string): boolean;
    /** Delete the entry. Returns false on any error. */
    delete(): boolean;
}

/** Options passed to each backend constructor. */
export interface KeychainBackendOptions {
    /** Service name registered with the keychain, e.g. "mcp-savvy/<namespace>". */
    service: string;
    /** Account name within the service. We use a fixed value. */
    account: string;
}

interface CommandEnvelope {
    status?: unknown;
    value?: unknown;
    category?: unknown;
}

const FAILURE_CATEGORIES: ReadonlySet<string> = new Set<KeychainReadFailureCategory>([
    'permission-denied',
    'integrity-failure',
    'invocation-failure',
    'operational-failure',
]);

/** Decode the allowlisted result envelope emitted by a controlled keychain command. */
export function decodeKeychainCommandResult(output: string): KeychainReadResult {
    let envelope: CommandEnvelope;
    try {
        envelope = JSON.parse(output) as CommandEnvelope;
    } catch {
        throw new KeychainReadError('operational-failure');
    }

    if (envelope.status === 'found' && typeof envelope.value === 'string') {
        return { status: 'found', value: envelope.value };
    }
    if (envelope.status === 'missing') return { status: 'missing' };
    if (envelope.status === 'unreadable-local-entry') {
        return { status: 'unreadable-local-entry' };
    }
    if (
        envelope.status === 'error' &&
        typeof envelope.category === 'string' &&
        FAILURE_CATEGORIES.has(envelope.category)
    ) {
        throw new KeychainReadError(envelope.category as KeychainReadFailureCategory);
    }
    throw new KeychainReadError('operational-failure');
}

/** Convert a subprocess exception into a sanitized fail-closed category. */
export function sanitizeKeychainCommandFailure(error: unknown): KeychainReadError {
    if (!error || typeof error !== 'object') return new KeychainReadError('invocation-failure');
    const code = 'code' in error ? error.code : undefined;
    if (code === 'EACCES' || code === 'EPERM') return new KeychainReadError('permission-denied');
    if (code === 'EBADMSG' || code === 'EILSEQ') return new KeychainReadError('integrity-failure');
    if (code === 'ENOENT' || !("status" in error)) {
        return new KeychainReadError('invocation-failure');
    }
    return new KeychainReadError('operational-failure');
}
