#!/usr/bin/env node
/** Generates ARCHITECTURE.md + the metadata JSON schemas from per-example YAML; --check fails on drift. */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOverview, loadExamples } from './architecture/load.mjs';
import { render } from './architecture/render.mjs';
import { EXAMPLE_META_SCHEMA, OVERVIEW_SCHEMA } from './architecture/schema.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const examplesDir = join(repoRoot, 'examples');
const sharedDir = join(examplesDir, '_shared', 'architecture');
const outPath = join(repoRoot, 'ARCHITECTURE.md');
const exampleSchemaPath = join(sharedDir, 'example-meta.schema.json');
const overviewSchemaPath = join(sharedDir, 'overview.schema.json');

/** Build every generated artifact as a { path, content } entry. */
function buildArtifacts() {
    const overview = loadOverview(sharedDir);
    const examples = loadExamples(examplesDir);
    return [
        { path: outPath, content: `${render(overview, examples).replace(/\n+$/, '')}\n` },
        { path: exampleSchemaPath, content: `${JSON.stringify(EXAMPLE_META_SCHEMA, null, 2)}\n` },
        { path: overviewSchemaPath, content: `${JSON.stringify(OVERVIEW_SCHEMA, null, 2)}\n` },
    ];
}

/** Read a file, returning '' when it does not exist. */
function readCurrent(path) {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return '';
    }
}

const checkMode = process.argv.includes('--check');
const artifacts = buildArtifacts();

if (checkMode) {
    const stale = artifacts.filter((a) => readCurrent(a.path) !== a.content);
    if (stale.length) {
        const names = stale.map((a) => a.path.replace(`${repoRoot}/`, '')).join(', ');
        console.error(`Stale generated file(s): ${names}. Run \`make architecture\` and commit the result.`);
        process.exit(1);
    }
    console.log('ARCHITECTURE.md and metadata schemas are up to date.');
} else {
    for (const a of artifacts) writeFileSync(a.path, a.content);
    console.log(`Wrote ${artifacts.length} generated file(s): ARCHITECTURE.md + metadata schemas.`);
}
