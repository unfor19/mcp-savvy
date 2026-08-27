/**
 * Minimal GitHub OpenAPI spec for the gateway-3lo-mcp demo.
 *
 * AgentCore Gateway's L2 validator rejects YAML, top-level
 * `security` blocks, `oneOf`/`anyOf`/`allOf` compositions, ops
 * without `operationId`, and unsupported parameter serialization
 * styles. We keep the spec narrow on purpose:
 *   - GET /user            → github___getAuthenticatedUser
 *   - GET /user/repos      → github___listUserRepos
 *
 * Auth is configured at the gateway level via an
 * `OAuthCredentialProviderConfiguration` (the `github`
 * GithubOauth2 credential provider in the sandbox), so this
 * spec deliberately omits any `security` block — the L2
 * forbids it there.
 */

/** OpenAPI 3.0.3 JSON spec, narrow enough to pass L2 validation. */
export const GITHUB_OPENAPI_SPEC = {
    openapi: '3.0.3',
    info: {
        title: 'GitHub API (mcp-savvy 3LO demo subset)',
        description:
            'Minimal GitHub API surface for exercising the AgentCore Gateway 3LO ' +
            'flow end-to-end via mcp-savvy.',
        version: '1.0.0',
    },
    servers: [
        {
            url: 'https://api.github.com',
            description: 'GitHub REST API',
        },
    ],
    paths: {
        '/user': {
            get: {
                operationId: 'getAuthenticatedUser',
                summary: 'Get the authenticated user',
                description:
                    'Returns the authenticated user\'s GitHub profile (login, id, name).',
                tags: ['users'],
                responses: {
                    '200': {
                        description: 'Authenticated user profile.',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/User' },
                            },
                        },
                    },
                },
            },
        },
        '/user/repos': {
            get: {
                operationId: 'listUserRepos',
                summary: 'List repositories the authenticated user can access',
                description:
                    'Lists repositories the authenticated user has access to. ' +
                    'Use the per_page query parameter to cap the response size.',
                tags: ['repos'],
                parameters: [
                    {
                        name: 'per_page',
                        in: 'query',
                        description: 'Results per page (max 100, default 30).',
                        required: false,
                        schema: { type: 'integer', minimum: 1, maximum: 100 },
                    },
                    {
                        name: 'sort',
                        in: 'query',
                        description: 'Sort key (created, updated, pushed, full_name).',
                        required: false,
                        schema: {
                            type: 'string',
                            enum: ['created', 'updated', 'pushed', 'full_name'],
                        },
                    },
                ],
                responses: {
                    '200': {
                        description: 'Array of repository summaries.',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'array',
                                    items: { $ref: '#/components/schemas/Repository' },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
    components: {
        schemas: {
            User: {
                type: 'object',
                properties: {
                    login: { type: 'string' },
                    id: { type: 'integer' },
                    name: { type: 'string' },
                    email: { type: 'string' },
                },
            },
            Repository: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    name: { type: 'string' },
                    full_name: { type: 'string' },
                    description: { type: 'string' },
                    private: { type: 'boolean' },
                    html_url: { type: 'string' },
                },
            },
        },
    },
} as const;

/** Stringified spec — what the L2 `ApiSchema.fromInline` accepts. */
export const GITHUB_OPENAPI_SPEC_JSON = JSON.stringify(GITHUB_OPENAPI_SPEC);
