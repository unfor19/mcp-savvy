/** Loads, parses, and validates the architecture overview + per-example metadata YAML files. */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { validate } from './validate.mjs';
import { EXAMPLE_META_SCHEMA, OVERVIEW_SCHEMA } from './schema.mjs';

/** Parse a YAML file and throw a labelled error on failure. */
function readYaml(path) {
    try {
        return parse(readFileSync(path, 'utf8'));
    } catch (err) {
        throw new Error(`failed to parse ${path}: ${err.message}`);
    }
}

/** Load + validate the cross-cutting overview.yaml. */
export function loadOverview(sharedDir) {
    const path = join(sharedDir, 'overview.yaml');
    const data = readYaml(path);
    const errors = validate(OVERVIEW_SCHEMA, data);
    if (errors.length) throw new Error(`${path} invalid:\n  - ${errors.join('\n  - ')}`);
    return data;
}

/** Load + validate every examples/<name>/example.yaml; returns them as an array. */
export function loadExamples(examplesDir) {
    const out = [];
    for (const entry of readdirSync(examplesDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
        const path = join(examplesDir, entry.name, 'example.yaml');
        if (!existsSync(path)) continue;
        const data = readYaml(path);
        const errors = validate(EXAMPLE_META_SCHEMA, data);
        if (errors.length) throw new Error(`${path} invalid:\n  - ${errors.join('\n  - ')}`);
        if (data.slug !== entry.name) {
            throw new Error(`${path}: slug '${data.slug}' does not match directory '${entry.name}'`);
        }
        out.push(data);
    }
    if (out.length === 0) throw new Error(`no example.yaml files found under ${examplesDir}`);
    return out;
}
