/**
 * Public surface of `@mcp-savvy/storage`.
 */

export type { TokenStore, TokenStoreOptions } from './types.js';
export { EncryptedFileTokenStore } from './encryptedFile.js';
export { AutoTokenStore, resolveTokenStore } from './auto.js';
export type { AutoTokenStoreInternalOptions } from './auto.js';
export { nodeRunner } from './runner.js';
export type { Runner, RunResult } from './runner.js';
export {
    selectKeychain,
    MacOSKeychain,
    WindowsCredentialManager,
    LinuxSecretService,
} from './keychain/index.js';
export type {
    KeychainBackend,
    KeychainBackendOptions,
    SelectKeychainOverrides,
} from './keychain/index.js';
/** Cross-process mutex coordinator for token-store mutations. */
export { LockCoordinator } from './lock/index.js';
/** Public types for `LockCoordinator.acquire` / `release` / construction. */
export type {
    AcquireOptions,
    LockHandle,
    LockCoordinatorOptions,
} from './lock/index.js';
