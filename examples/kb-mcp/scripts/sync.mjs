#!/usr/bin/env node
/**
 * Sync the shared corpus to the KB source bucket.
 *
 * Reads `examples/_shared/kb-corpus/posts/*.md`, computes a content
 * hash for every file, and PUTs each one to
 * `s3://<sourceBucket>/posts/<filename>` with x-amz-meta-* fields
 * carrying the YAML frontmatter (url, title, published, tags,
 * read_minutes, author, source). Bedrock KB makes those metadata
 * fields filterable on the index, so the agent can cite the source
 * URL of every retrieved chunk.
 *
 * Idempotent: skips uploads when the local file's SHA-256 matches the
 * `x-amz-meta-content-sha256` of the live object.
 *
 * Inputs (all required, supplied by the Makefile target):
 *   MCP_SAVVY_KB_SOURCE_BUCKET  — bucket name from `KbStack`'s
 *                                 SourceBucketName output
 *   AWS_REGION                  — region for the S3 client
 *
 * Run via `make example-kb-sync` (don't invoke directly unless you
 * have the env vars).
 */

import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    S3Client,
    HeadObjectCommand,
    PutObjectCommand,
} from '@aws-sdk/client-s3';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = resolve(HERE, '..', '..', '_shared', 'kb-corpus', 'posts');

const BUCKET = process.env.MCP_SAVVY_KB_SOURCE_BUCKET;
const REGION = process.env.AWS_REGION ?? 'us-east-1';
if (!BUCKET) {
    console.error('missing env: MCP_SAVVY_KB_SOURCE_BUCKET');
    process.exit(2);
}

const s3 = new S3Client({ region: REGION });

/** Parse YAML frontmatter into a flat string-keyed object. Tiny by design. */
function parseFrontmatter(text) {
    if (!text.startsWith('---\n')) return { fm: {}, body: text };
    const end = text.indexOf('\n---\n', 4);
    if (end === -1) return { fm: {}, body: text };
    const block = text.slice(4, end);
    const body = text.slice(end + 5);
    const fm = {};
    for (const line of block.split('\n')) {
        const m = line.match(/^([a-z_]+):\s*(.*)$/);
        if (!m) continue;
        const key = m[1];
        let val = m[2].trim();
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        if (val.startsWith('[') && val.endsWith(']')) {
            val = val
                .slice(1, -1)
                .split(',')
                .map((s) => s.trim().replace(/^["']|["']$/g, ''))
                .filter(Boolean)
                .join(',');
        }
        fm[key] = val;
    }
    return { fm, body };
}

/**
 * S3 user-defined metadata is constrained: keys lowercase, values
 * ASCII-printable, total under 2KB. We pick the frontmatter fields
 * Bedrock KB will index and skip the rest.
 */
function buildS3Metadata(fm) {
    const meta = {};
    for (const k of ['url', 'title', 'published', 'author', 'source', 'tags']) {
        const v = fm[k];
        if (typeof v === 'string' && v.length > 0 && v.length < 1024) {
            meta[k] = v;
        }
    }
    return meta;
}

async function liveSha(key) {
    try {
        const head = await s3.send(
            new HeadObjectCommand({ Bucket: BUCKET, Key: key }),
        );
        return head.Metadata?.['content-sha256'] ?? null;
    } catch (err) {
        if (err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
    }
}

async function main() {
    const entries = await readdir(CORPUS_DIR);
    const mdFiles = entries.filter((e) => e.endsWith('.md')).sort();
    if (mdFiles.length === 0) {
        console.error(`no .md files under ${CORPUS_DIR}`);
        process.exit(1);
    }

    let uploaded = 0;
    let skipped = 0;
    for (const name of mdFiles) {
        const path = join(CORPUS_DIR, name);
        const buf = await readFile(path);
        const sha = createHash('sha256').update(buf).digest('hex');
        const key = `posts/${name}`;

        const live = await liveSha(key);
        if (live === sha) {
            skipped += 1;
            console.log(`= ${key} (sha matches, skipped)`);
            continue;
        }

        const { fm } = parseFrontmatter(buf.toString('utf8'));
        const meta = buildS3Metadata(fm);
        meta['content-sha256'] = sha;

        await s3.send(
            new PutObjectCommand({
                Bucket: BUCKET,
                Key: key,
                Body: buf,
                ContentType: 'text/markdown',
                Metadata: meta,
            }),
        );
        uploaded += 1;
        console.log(`+ ${key} (${buf.length} bytes)`);
    }

    console.log(
        `\nkb-sync done: ${uploaded} uploaded, ${skipped} unchanged, ${mdFiles.length} total.`,
    );
}

main().catch((err) => {
    console.error(`kb-sync failed: ${err.stack ?? err.message ?? err}`);
    process.exit(1);
});
