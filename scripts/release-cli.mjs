#!/usr/bin/env node
/** Build, verify, inspect, and optionally publish an immutable CLI tarball. */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFiles, scanRepository } from './check-secrets.mjs';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SAFE_ENV_NAMES = new Set([
    'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);
const NETWORK_ENV_NAMES = new Set([
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy',
]);
const PUBLISH_ENV_NAMES = new Set([
    ...SAFE_ENV_NAMES,
    ...NETWORK_ENV_NAMES,
    'HOME', 'USERPROFILE', 'NPM_TOKEN', 'NODE_AUTH_TOKEN',
    'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_REGISTRY',
]);
const REQUIRED_FILES = [
    'package.json', 'README.md', 'LICENSE', 'dist/cli.cjs',
    'dist/index.js', 'dist/index.cjs', 'dist/index.d.ts', 'dist/index.d.cts',
];

/** Return the credential-free environment used for install, build, test, and pack. */
export function releaseEnvironment(source, home) {
    const env = Object.fromEntries(
        Object.entries(source).filter(([name]) => SAFE_ENV_NAMES.has(name)),
    );
    return {
        ...env,
        HOME: home,
        USERPROFILE: home,
        CI: '1',
        RELEASE_ISOLATED: '1',
        COREPACK_HOME: join(home, '.corepack'),
        npm_config_cache: join(home, '.npm'),
        XDG_CACHE_HOME: join(home, '.cache'),
        UV_CACHE_DIR: join(home, '.cache', 'uv'),
    };
}

/** Return the environment used only by lifecycle-script-free dependency installation. */
export function installEnvironment(source, home) {
    const env = releaseEnvironment(source, home);
    for (const [name, value] of Object.entries(source)) {
        if (NETWORK_ENV_NAMES.has(name)) env[name] = value;
    }
    return env;
}

/** Return the narrow environment allowed only for the final npm publication process. */
export function publishEnvironment(source) {
    return Object.fromEntries(
        Object.entries(source).filter(([name]) => PUBLISH_ENV_NAMES.has(name)),
    );
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { stdio: 'inherit', ...options });
    if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

function capture(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', ...options });
    if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
    return result.stdout.trim();
}

function assertCleanSource(repo) {
    const status = capture('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
        cwd: repo,
        env: releaseEnvironment(process.env, tmpdir()),
    });
    if (status.length > 0) throw new Error('release requires a clean committed source tree');
    const sourceScan = scanRepository(repo);
    if (sourceScan.hits.length > 0) {
        throw new Error(`source tree failed the secret scan (${sourceScan.hits.length} hit(s))`);
    }
}

function inspectPackReport(report, destination, isolatedRepo) {
    const files = new Set((report.files ?? []).map((entry) => entry.path));
    for (const required of REQUIRED_FILES) {
        if (!files.has(required)) throw new Error(`packed artifact is missing ${required}`);
    }
    for (const file of files) {
        if (!(file === 'package.json' || file === 'README.md' || file === 'LICENSE' || file.startsWith('dist/'))) {
            throw new Error(`packed artifact contains unexpected path ${file}`);
        }
    }
    const tarball = join(destination, report.filename);
    if (!existsSync(tarball)) throw new Error('npm pack reported an artifact that does not exist');
    const extracted = join(destination, 'unpacked');
    mkdirSync(extracted);
    run('tar', ['-xzf', tarball, '-C', extracted], {
        env: releaseEnvironment(process.env, join(destination, 'home')),
    });
    const artifactScan = scanFiles(join(extracted, 'package'), [...files], isolatedRepo);
    if (artifactScan.hits.length > 0) {
        throw new Error(`packed artifact failed the secret scan (${artifactScan.hits.length} hit(s))`);
    }
    return tarball;
}

function smokeTestTarball(tarball, destination, cleanEnv) {
    const consumer = join(destination, 'consumer');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
    writeFileSync(
        join(consumer, 'index.ts'),
        "import { loadConfig, deriveNamespace } from 'mcp-savvy';\nvoid loadConfig;\nvoid deriveNamespace;\n",
    );
    writeFileSync(
        join(consumer, 'tsconfig.json'),
        JSON.stringify({
            compilerOptions: {
                module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022',
                strict: true, noEmit: true, skipLibCheck: false,
            },
            include: ['index.ts'],
        }),
    );
    run('npm', [
        'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball,
        'typescript@5.9', '@types/node@20',
    ], {
        cwd: consumer,
        env: cleanEnv,
    });
    const node20 = ['--yes', '--package=node@20', '--', 'node'];
    run('npx', [...node20, '--input-type=module', '-e', "await import('mcp-savvy')"], {
        cwd: consumer,
        env: cleanEnv,
    });
    run('npx', [...node20, '-e', "require('mcp-savvy')"], { cwd: consumer, env: cleanEnv });
    run('npx', [...node20, 'node_modules/mcp-savvy/dist/cli.cjs', '--help'], {
        cwd: consumer,
        env: cleanEnv,
    });
    run('npx', ['--no-install', 'tsc', '--project', 'tsconfig.json'], {
        cwd: consumer,
        env: cleanEnv,
    });
}

/** Execute the clean-snapshot CLI release flow and return the inspected artifact metadata. */
export function runRelease({ publish = false, repo = REPO } = {}) {
    assertCleanSource(repo);
    const revision = capture('git', ['rev-parse', 'HEAD'], { cwd: repo });
    const destination = mkdtempSync(join(tmpdir(), 'mcp-savvy-release-'));
    const workspace = join(destination, 'workspace');
    const home = join(destination, 'home');
    const sourceTar = join(destination, 'source.tar');
    mkdirSync(workspace);
    mkdirSync(home);
    const cleanEnv = releaseEnvironment(process.env, home);

    run('git', ['archive', '--format=tar', '--output', sourceTar, revision], {
        cwd: repo,
        env: cleanEnv,
    });
    run('tar', ['-xf', sourceTar, '-C', workspace], { env: cleanEnv });
    run('git', ['init', '--quiet'], { cwd: workspace, env: cleanEnv });
    run('git', ['add', '--all'], { cwd: workspace, env: cleanEnv });
    run('corepack', ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'], {
        cwd: workspace,
        env: installEnvironment(process.env, home),
    });
    run('make', ['verify'], { cwd: workspace, env: cleanEnv });

    const cli = join(workspace, 'packages', 'cli');
    const packed = spawnSync(
        'npm',
        ['pack', '--json', '--ignore-scripts', '--pack-destination', destination],
        { cwd: cli, encoding: 'utf8', env: cleanEnv },
    );
    if (packed.status !== 0) throw new Error(`npm pack failed with exit code ${packed.status}`);
    const reports = JSON.parse(packed.stdout);
    if (!Array.isArray(reports) || reports.length !== 1) {
        throw new Error('npm pack returned no unique artifact');
    }
    const tarball = inspectPackReport(reports[0], destination, workspace);
    smokeTestTarball(tarball, destination, installEnvironment(process.env, home));
    const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    process.stdout.write(`Release source: ${revision}\nInspected artifact: ${tarball}\nSHA256: ${sha256}\n`);

    if (publish) {
        run('npm', ['publish', tarball, '--access', 'public', '--ignore-scripts'], {
            cwd: destination,
            env: publishEnvironment(process.env),
        });
    }
    return { revision, tarball, sha256 };
}

const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
    const unexpected = process.argv.slice(2).filter((arg) => arg !== '--publish');
    if (unexpected.length > 0) {
        process.stderr.write('Usage: node scripts/release-cli.mjs [--publish]\n');
        process.exit(2);
    }
    try {
        runRelease({ publish: process.argv.includes('--publish') });
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
    }
}
