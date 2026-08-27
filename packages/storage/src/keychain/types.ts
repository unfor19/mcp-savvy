/**
 * Internal interface implemented by each platform-specific keychain
 * backend. Mirrors the public TokenStore but operates on raw strings
 * (the auto-resolver handles JSON serialization).
 */

export interface KeychainBackend {
    /** Stable display name shown by the logger ("macOS Keychain", etc.). */
    readonly name: string;
    /** True if this backend can run on the current host. */
    isAvailable(): boolean;
    /** Read the value, or null if absent or the CLI errored. */
    get(): string | null;
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
