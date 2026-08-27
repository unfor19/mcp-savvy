/**
 * esbuild bundling for the chatgpt-app-mcp Lambda asset.
 *
 * Bundles `examples/chatgpt-app-mcp/server/index.mjs` into a single
 * ESM file at synth time. `jose` and other userland deps are
 * inlined; AWS SDK clients are externalised (the Node 22 Lambda
 * runtime ships them). The widget's `balance.html`/`balance.css`/
 * `balance.js` are read at module load via `readFileSync`, so we
 * also copy them alongside the bundled JS — esbuild doesn't trace
 * runtime file reads.
 *
 * Asset hash is derived from the bundled output (`AssetHashType.OUTPUT`)
 * so `cdk.context.json` doesn't pin to source-tree mtime quirks.
 */

import * as path from 'node:path';
import { copyFileSync, mkdirSync } from 'node:fs';
import * as esbuild from 'esbuild';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Build the CDK `AssetCode` for the MCP server Lambda. Caller
 * provides the absolute path to the `server/` source directory.
 */
export function bundleServerCode(serverSrcDir: string): lambda.AssetCode {
    return lambda.Code.fromAsset(serverSrcDir, {
        assetHashType: cdk.AssetHashType.OUTPUT,
        bundling: {
            image: lambda.Runtime.NODEJS_22_X.bundlingImage,
            local: {
                tryBundle(outputDir: string): boolean {
                    esbuild.buildSync({
                        entryPoints: [path.join(serverSrcDir, 'index.mjs')],
                        outfile: path.join(outputDir, 'index.mjs'),
                        absWorkingDir: serverSrcDir,
                        bundle: true,
                        platform: 'node',
                        target: 'node22',
                        format: 'esm',
                        sourcemap: false,
                        minify: false,
                        external: ['@aws-sdk/*'],
                        banner: {
                            js:
                                '// mcp-savvy chatgpt-app-mcp server bundle - generated at ' +
                                'synth time by examples/chatgpt-app-mcp/infra/lib/app-stack/.',
                        },
                        logLevel: 'error',
                    });
                    mkdirSync(path.join(outputDir, 'widget'), { recursive: true });
                    for (const name of [
                        'common.js',
                        'balance.html', 'balance.css', 'balance.js',
                        'branches.html', 'branches.css', 'branches.js',
                    ]) {
                        copyFileSync(
                            path.join(serverSrcDir, 'widget', name),
                            path.join(outputDir, 'widget', name),
                        );
                    }
                    return true;
                },
            },
            command: [
                'bash',
                '-c',
                'echo "Docker bundling fallback unavailable; install Node deps locally so ' +
                'esbuild can run via tryBundle." && exit 1',
            ],
        },
    });
}
