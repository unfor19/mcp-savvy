/**
 * Tiny AWS-CLI shell helper shared by chatgpt-app-mcp scripts.
 *
 * Each script is a single-purpose `node ./scripts/<thing>.mjs`
 * driver; we deliberately avoid pulling in `@aws-sdk/*` clients so
 * the scripts stay zero-dep beyond what the user's local AWS CLI
 * already provides. The trade-off is that command-shape mistakes
 * surface as CLI exit codes rather than typed errors, but the
 * surface is small (cognito-idp + dynamodb).
 */

import { spawnSync } from 'node:child_process';
import { env, exit, stderr } from 'node:process';

/**
 * Run an `aws ...` command synchronously and return the CLI's
 * stdout (typically JSON when `--output json` is on the args list).
 *
 * Exits the process with the CLI's exit code on non-zero. The
 * scripts in this directory don't have tolerate-failure cases yet;
 * if one is needed, swap to `awsRaw` and key off `result.status`.
 */
export function aws(args) {
    const result = awsRaw(args);
    if (result.status !== 0) {
        stderr.write(result.stderr || `aws ${args.join(' ')} failed\n`);
        exit(result.status);
    }
    return result.stdout;
}

/** Run an `aws ...` command and return `{ stdout, stderr, status }` regardless of exit code. */
export function awsRaw(args) {
    const result = spawnSync('aws', args, {
        encoding: 'utf8',
        env: { ...env, AWS_REGION: env.AWS_REGION ?? 'us-east-1' },
    });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? 0 };
}
