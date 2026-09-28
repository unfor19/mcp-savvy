/** Resolve deterministic, sanitized credential cache identities. */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { deriveNamespace } from '../namespace.js';

const FINGERPRINT_VERSION = 'effective-cache-identity:v1';
const FINGERPRINT_LENGTH = 16;

/** Inputs that determine whether independent processes share credentials. */
export interface EffectiveCacheIdentityInput {
    issuer: string;
    clientId: string;
    namespaceOverride?: string;
    dataDir: string;
    userContext: string;
}

/** Sanitized, deterministic identity details safe for diagnostics. */
export interface EffectiveCacheIdentity {
    namespace: string;
    dataDir: string;
    fingerprint: string;
    componentFingerprints: {
        issuer: string;
        clientId: string;
        namespace: string;
        dataDir: string;
    };
}

/** Resolve the namespace, canonical data directory, and safe identity fingerprints. */
export function resolveEffectiveCacheIdentity(
    input: EffectiveCacheIdentityInput,
): EffectiveCacheIdentity {
    const namespaceOverride = input.namespaceOverride?.trim();
    const namespace = namespaceOverride || deriveNamespace(input.issuer, input.clientId);
    const dataDir = resolve(input.dataDir);

    return {
        namespace,
        dataDir,
        fingerprint: fingerprint([namespace, dataDir, input.userContext]),
        componentFingerprints: {
            issuer: fingerprint([input.issuer]),
            clientId: fingerprint([input.clientId]),
            namespace: fingerprint([namespace]),
            dataDir: fingerprint([dataDir]),
        },
    };
}

function fingerprint(parts: readonly string[]): string {
    const hash = createHash('sha256');
    hash.update(`${FINGERPRINT_VERSION.length}:${FINGERPRINT_VERSION}`);
    for (const part of parts) {
        hash.update(`|${Buffer.byteLength(part, 'utf8')}:`);
        hash.update(part);
    }
    return hash.digest('hex').slice(0, FINGERPRINT_LENGTH);
}
