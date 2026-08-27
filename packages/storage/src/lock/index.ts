/**
 * Public surface of the LockCoordinator submodule.
 *
 * Re-exports the coordinator class, its public types, and the
 * correlation-id helper so callers can import from
 * `@mcp-savvy/storage/lock` (or, for the curated subset,
 * `@mcp-savvy/storage`) without reaching into individual files.
 */

export { LockCoordinator } from './coordinator.js';
export type {
    AcquireOptions,
    LockHandle,
    LockCoordinatorOptions,
} from './types.js';
export { newCorrelationId } from './correlationId.js';
