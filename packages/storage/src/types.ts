/**
 * Public types for the storage layer.
 */

import type { TokenData } from '@mcp-savvy/core';

/**
 * Persistent OAuth/OIDC token store.
 *
 * Implementations may use the OS keychain, an encrypted file, or
 * memory (for tests). All methods are async because some backends
 * (keychain CLIs) shell out.
 */
export interface TokenStore {
    /** Read the stored token bundle, or null if absent or unreadable. */
    get(): Promise<TokenData | null>;
    /** Persist a token bundle. Overwrites any prior value. */
    set(tokens: TokenData): Promise<void>;
    /** Remove any persisted token bundle. */
    clear(): Promise<void>;
}

/**
 * Options accepted by the auto-resolver and individual backend
 * factories.
 *
 * `namespace` scopes the storage so multiple protected MCPs can
 * coexist on the same machine without trampling each other's
 * tokens. Defaults are derived from issuer + clientId by the CLI.
 *
 * `dataDir` selects the root for encrypted-file storage. `homedir`
 * changes the machine-bound key input and default storage root; tests
 * use it as a deterministic seam.
 */
export interface TokenStoreOptions {
    /** Suffix appended to the service name; e.g. "auth.example.com-abc12345". */
    namespace: string;
    /** Explicit root for the encrypted file fallback. */
    dataDir?: string;
    /** Override `os.homedir()` for the default root and key derivation. Test seam. */
    homedir?: string;
}
