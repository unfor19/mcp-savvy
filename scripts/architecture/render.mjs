/** Renders the parsed overview + per-example metadata into the ARCHITECTURE.md body. */

const STATUS_BADGE = {
    validated: '✅ validated',
    deployable: '🟦 deployable',
    scaffold: '🚧 scaffold',
    planned: '⏳ planned',
};

const BACKEND_LABEL = { runtime: 'AgentCore Runtime', gateway: 'AgentCore Gateway', lambda: 'Lambda MCP' };
const FRONTING_LABEL = { direct: 'Direct (no front door)', 'rest-api': 'REST API front door' };
const IDP_LABEL = { cognito: 'Cognito', 'imported-cognito': 'imported Cognito', entra: 'Entra ID' };

/** Build the full ARCHITECTURE.md string from the overview and example metadata. */
export function render(overview, examples) {
    const sorted = [...examples].sort(
        (a, b) => cellOrder(a.matrixCell) - cellOrder(b.matrixCell) || a.slug.localeCompare(b.slug),
    );
    return [
        header(),
        purpose(overview),
        matrix(overview, sorted),
        dataFlow(overview),
        examplesSection(sorted),
        idpSection(overview),
        footer(),
    ].join('\n\n');
}

/** Generated-file banner + title. */
function header() {
    return [
        '# mcp-savvy — Architecture & Examples',
        '',
        '> Auto-generated from `examples/*/example.yaml` and',
        '> `examples/_shared/architecture/overview.yaml` by',
        '> `scripts/gen-architecture.mjs`. Do not edit by hand — run',
        '> `make architecture` after changing an example or its metadata.',
        '',
        'A single page for handing someone the *what* and the *why*: the',
        'purpose, the deployment shapes mcp-savvy covers, and every example',
        'on the grid. For the quickstart see [README.md](./README.md);',
        'for detailed capabilities see [FEATURES.md](./FEATURES.md).',
    ].join('\n');
}

/** Purpose paragraphs. */
function purpose(overview) {
    return ['## Purpose', '', overview.purpose.join('\n\n')].join('\n');
}

/** The 2x2 matrix table with examples slotted into cells. */
function matrix(overview, examples) {
    const cell = (backend, fronting) =>
        examples
            .filter((e) => e.backend === backend && e.fronting === fronting)
            .map((e) => `(${e.matrixCell}) [\`${e.slug}\`](./examples/${e.slug}) ${STATUS_BADGE[e.status]}`)
            .join('<br>') || '—';
    return [
        '## The architecture matrix',
        '',
        'Three backend surfaces (Runtime hosts your code; Gateway exposes other',
        "people's APIs as MCP tools; Lambda MCP hosts the MCP server in a plain",
        'Lambda for cases where AgentCore is overkill or VPC isolation is the',
        'point) crossed with whether the backend is called directly or behind a',
        'REST API front door.',
        '',
        `- **Backend axis** — ${overview.matrixAxes.backend}`,
        `- **Fronting axis** — ${overview.matrixAxes.fronting}`,
        '',
        '|                       | **Direct** | **REST API front door** |',
        '| --------------------- | ---------- | ----------------------- |',
        `| **AgentCore Runtime** | ${cell('runtime', 'direct')} | ${cell('runtime', 'rest-api')} |`,
        `| **AgentCore Gateway** | ${cell('gateway', 'direct')} | ${cell('gateway', 'rest-api')} |`,
        `| **Lambda MCP**        | ${cell('lambda', 'direct')} | ${cell('lambda', 'rest-api')} |`,
        '',
        'Identity support varies by example and is listed in each entry below.',
        'The toolkit also supports external OIDC providers — see [identity providers](#identity-providers).',
    ].join('\n');
}

/** Bridge data-flow diagram. */
function dataFlow(overview) {
    return ['## How a request flows', '', '```', overview.dataFlow.replace(/\n$/, ''), '```'].join('\n');
}

/** One subsection per example. */
function examplesSection(examples) {
    return ['## Examples', '', ...examples.map(exampleBlock)].join('\n');
}

/** Render a single example's subsection. */
function exampleBlock(e) {
    const lines = [
        `### (${e.matrixCell}) ${e.title} — \`${e.slug}\``,
        '',
        `${STATUS_BADGE[e.status]}${e.statusNote ? ` — ${e.statusNote}` : ''}`,
        '',
        e.tagline,
    ];
    if (e.useCase) lines.push('', e.useCase);
    lines.push(
        '',
        `- **Shape**: ${BACKEND_LABEL[e.backend]} · ${FRONTING_LABEL[e.fronting]}`,
        `- **Constructs**: ${e.constructs.map((c) => `\`${c}\``).join(', ')}`,
        `- **Identity**: ${e.identityProviders.map((p) => IDP_LABEL[p]).join(', ')}`,
    );
    if (e.toolMode) lines.push(`- **Tool mode**: \`${e.toolMode}\``);
    lines.push(`- **Deploy**: \`make ${makePrefix(e)}-deploy\``);
    if (e.hostTools?.length) {
        lines.push('', '| Host-facing tool | What it does |', '| --- | --- |');
        for (const t of e.hostTools) lines.push(`| \`${t.name}\` | ${t.summary} |`);
    }
    lines.push('', '| Stack | Purpose |', '| --- | --- |');
    for (const s of e.stacks) lines.push(`| \`${s.id}\` | ${s.summary} |`);
    if (e.relatedExamples?.length) {
        lines.push('', `Compare with: ${e.relatedExamples.map((s) => `[\`${s}\`](./examples/${s})`).join(', ')}.`);
    }
    lines.push('');
    return lines.join('\n');
}

/** Cross-cutting IdP table. */
function idpSection(overview) {
    const rows = overview.identityProviders.map(
        (p) => `| ${p.name} | \`${p.issuer}\` | ${p.notes ?? ''} |`,
    );
    return [
        '## Identity providers',
        '',
        'The `IdentityProvider` abstraction makes JWT-authorizer wiring',
        'identical across IdPs. Cognito is the zero-config default; any',
        'OIDC-compliant IdP drops in by changing `MCP_SAVVY_OIDC_ISSUER` +',
        '`MCP_SAVVY_CLIENT_ID`.',
        '',
        '| IdP | Issuer URL | Notes |',
        '| --- | --- | --- |',
        ...rows,
    ].join('\n');
}

/** Closing pointer back to the deeper docs. */
function footer() {
    return [
        '---',
        '',
        'See also: [README.md](./README.md) (quickstart) ·',
        '[FEATURES.md](./FEATURES.md) (long-form features) ·',
        '[SECURITY.md](./SECURITY.md) (threat model).',
    ].join('\n');
}

/** Makefile target prefix for an example, defaulting to example-<slug-without-trailing-mcp>. */
function makePrefix(e) {
    return e.makePrefix ?? `example-${e.slug.replace(/-mcp$/, '')}`;
}

/** Sort key so matrix cells render A, A2, B, C, E, F, G. */
function cellOrder(cell) {
    return ['A', 'A2', 'B', 'C', 'E', 'F', 'G'].indexOf(cell);
}
