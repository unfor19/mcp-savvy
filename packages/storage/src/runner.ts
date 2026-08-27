/**
 * Pluggable runner around `child_process.execFileSync` / `spawnSync`.
 *
 * Production code uses the default `nodeRunner` which delegates to the
 * real `node:child_process`. Tests inject a fake runner so we don't
 * shell out to the host's keychain (and so coverage reports the actual
 * source lines instead of vitest mock indirection).
 */

import { execFileSync, spawnSync } from 'node:child_process';

/** Result of a `runWithStdin` call. */
export interface RunResult {
    /** Process exit status. 0 = success. */
    status: number;
}

/** Pluggable subprocess runner. All methods are sync because the */
export interface Runner {
    /** Run `cmd` with `args`, returning stdout as utf8. Throws on non-zero exit. */
    run(cmd: string, args: readonly string[]): string;
    /** Same as `run` but pipes `input` to stdin (no leak via argv). */
    runWithStdin(cmd: string, args: readonly string[], input: string): RunResult;
}

const STDIO: ['pipe', 'pipe', 'pipe'] = ['pipe', 'pipe', 'pipe'];

/** Default `Runner` implementation backed by `node:child_process`. */
export const nodeRunner: Runner = {
    run(cmd, args) {
        const out = execFileSync(cmd, args as string[], { encoding: 'utf8', stdio: STDIO });
        return out;
    },
    runWithStdin(cmd, args, input) {
        const result = spawnSync(cmd, args as string[], { input, stdio: STDIO });
        return { status: result.status ?? 1 };
    },
};
