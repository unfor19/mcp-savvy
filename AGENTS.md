# AGENTS.md — operating rules for agents on the mcp-savvy repo

Read this before doing anything. It defines how to work on this repository.

## Project intent

`mcp-savvy` is a toolkit that lets people ship protected MCP servers
on AWS without copy-pasting auth, infra, and a stdio bridge into every
new repo. The pitch: *"mcp-savvy is the expert MCP deployer, so you
only deal with your app."*

The shape is a Node monorepo (pnpm workspaces) that publishes one npm
package, plus CDK constructs, plus runnable examples.

README.md and FEATURES.md define the public product contract;
ARCHITECTURE.md and the example metadata define deployment truth.

## Always-loaded context

If steering files land under `.kiro/steering/`, they ship in every
conversation. If they exist and contradict this file, the steering
files win.

## Reference: `.agentcore-mcp`

`.agentcore-mcp/` is a symlink to a separate repo with a working
end-to-end implementation of the same auth + bridge + gateway shape
mcp-savvy is generalizing. It is **gitignored and must never appear
in the tracked tree**, but is the single best source of truth for
"what does the wire actually look like" questions.

**Read it first** when working in any of these areas:
- AgentCore Gateway 3LO (`auth.ts`, `gateway.ts`, `aws.ts`)
- The complete-session callback API + IAM grants
- The bridge's outgoing request shape (HTTP headers, `_meta`,
  protocol version, JWT choice between `access_token` and `id_token`)
- AgentCore Runtime / Identity wire formats
- The search-first tool-flattening pattern (the reference's
  `agentcore_call_tool` + `x_amz_bedrock_agentcore_search` wiring
  — mcp-savvy generalizes it as a per-server `MCP_SAVVY_TOOL_MODE`
  toggle. `search-local` mode goes one step further than the
  reference: it surfaces the discovered provider list as a typed
  JSON-Schema `enum` on `${prefix}_search` so the host LLM picks
  a provider from a menu and the bridge does a deterministic
  filter — no managed embedding model, no per-query AWS billing.
  See FEATURES.md for the public wire shape.)

Concretely: when you're about to add a new capability, IAM grant,
or wire detail, **grep `.agentcore-mcp/` first**. Re-deriving is
slow and bug-prone. Several v0.3 bugs (the `secretsmanager:GetSecretValue`
grant on the complete-session Lambda, the `grantType: AUTHORIZATION_CODE`
override on the OpenAPI target, the `id_token`-over-`access_token`
preference for opaque-aud IdPs, the `mcp-protocol-version: 2025-11-25`
header) were already solved there and only surfaced under live
deploy because we built without checking.

The reference is not authoritative on _how to ship_ this in a
library — it's a single-repo proxy. But for "does the gateway
require X to function," the answer is in there.

## Code style

### fon (always-on audit)

This repo is audited by **fon**. The relevant constraints:

- **300 lines per file max** (config in `.fon/check/config.yaml`).
- **10 files per directory max**.
- **First-line doc summary required** on every exported type, class,
  interface, and function. JSDoc-style `/** Foo does X. */` is fine.
- **Prefix grouping**: when 2+ files in a directory share a prefix
  (`foo_types.ts`, `foo_logic.ts`, `foo.ts`), regroup as `foo/` with
  `index.ts`, `types.ts`, `logic.ts`. The `_test.ts` / `.test.ts` /
  `.d.ts` exceptions still apply.
- **YAML files need a schema reference** as the first non-comment line:
  `# yaml-language-server: $schema=<url>`.
- **No hardcoded values**: thresholds and limits live in YAML / config,
  not source.

Run `fon check` after every meaningful edit. Treat it as part of
"definition of done" alongside `tsc --noEmit`.

If a check is wrong for a specific case, edit
`.fon/check/config.yaml` (add a `check_exceptions` entry) — never
silence a check by deleting the constraint.

For dive-deep work: `fon symbols <name>` and `fon imports <path>`.

### Node
- **`pnpm`** only. Lockfile is `pnpm-lock.yaml`. No `npm install`,
  no `yarn`.
- **Never hand-edit dependency versions** in `package.json`. Use
  `pnpm add <pkg>` / `pnpm add -D <pkg>` / `pnpm remove <pkg>` so the
  resolver picks the right version and writes to the lockfile in one
  step. Pin a version only when there's a specific reason (an
  upstream regression, a peer-dep constraint we're tracking) — and
  then still go through `pnpm add <pkg>@<version>`, not by editing
  `package.json` by hand.
- TypeScript **strict** mode, `noUncheckedIndexedAccess` on
  (set in `tsconfig.base.json`). Prefer explicit return types on
  exported functions.
- ESM-only. `"type": "module"` in every package.
- Node baseline is **20** (LTS).
- Each package owns its `tsconfig.json` extending
  `../../tsconfig.base.json`.

### CDK (later)
- TypeScript only. Pin `aws-cdk-lib` exactly. Never instantiate the
  AWS SDK directly inside a construct — use L2 wrappers from
  `aws-cdk-lib/aws-*`.
- Construct API is the public surface. Treat it like a library;
  semver applies once we ship `@mcp-savvy/cdk`.
- **CFN overrides are sometimes the right answer.** The L2
  `aws_bedrockagentcore` constructs lag the service by a few minor
  versions. When a wire-level property is missing (e.g.
  `OAuthCredentialProviderConfiguration.grantType`), drop down via
  `target.node.defaultChild.addPropertyOverride(...)` rather than
  forking the L2 or working around. Each override goes with a
  comment naming the field, why the L2 doesn't expose it yet, and
  a link to the AWS docs. Keep each override next to the construct so
  it can be removed when the L2 catches up.

#### Lessons learned (don't repeat these)

These are live-deployment lessons that should not be rediscovered:

- **AgentCore Gateway's workload-identity name is NOT the gateway
  name.** The L2 appends a runtime-resolved 10-character suffix
  (`<gatewayName>-<random>`). The CFN attribute set doesn't expose
  the name; you must resolve it at deploy time via `GetGateway`
  (the response carries `workloadIdentityDetails.workloadIdentityArn`).
- **Two `AwsCustomResource`s sharing a singleton role race IAM
  eventual consistency.** Each one emits its own `AWS::IAM::Policy`
  resource against CDK's stack-level `AwsCustomResource` Lambda
  role. CFN can run the second invocation before the second policy
  attaches; IAM rejects with `AccessDenied`. Use a single
  Lambda-backed custom resource that does both calls in sequence.
- **Lambda Node 22 with bundled ESM crashes when transitive deps
  do `require('node:built-in')`.** Some AWS SDK clients (notably
  `@aws-sdk/client-bedrock-agentcore-control` via
  `@smithy/node-http-handler`) call `require('node:https')`
  synchronously at module load. esbuild's CJS-from-ESM shim
  mis-routes that. Emit those Lambdas as **CJS** (`index.cjs`,
  `format: 'cjs'`) instead of ESM.
- **cdk-nag suppression scoping.** `addResourceSuppressions(scope, ..., true)`
  reaches every child of `scope` — but **stack-level singletons CDK
  creates implicitly** (the `AwsCustomResource` Lambda, API Gateway's
  account-wide CloudWatch role, the `LogRetention` worker role) live
  at the stack root, outside the construct's scope. Reach them via
  `addResourceSuppressionsByPath(stack, '/<stack>/<id>/...', ...)`.
  Prefer the explicit `logGroup: new logs.LogGroup(...)` pattern over
  `logRetention: ...` so you don't summon the `LogRetention`
  singleton in the first place.
- **Strict cdk-nag synth flags `--strict` warnings too.** When the L2
  emits its own annotation warnings (e.g. the
  `aws-cdk-lib.aws-bedrockagentcore:wildcardSecretArnGrant` we
  acknowledge), use `cdk.Annotations.of(stack).acknowledgeWarning(id)`
  at the **stack** level, not the construct level — the warning is
  fired in the validation phase against the construct subtree, and
  child-level acknowledgments don't reliably propagate up.
- **CDK 2.257 emits an unconditional AgentCore Gateway service trust.**
  `AgentCoreGateway` overrides the generated role trust document so every
  `bedrock-agentcore.amazonaws.com` Allow has both `aws:SourceAccount` and a
  gateway-scoped `aws:SourceArn`. Keep that override until the L2 stops
  synthesizing the unconditional statement.

## Repo layout

Live (v0.1 in progress):

```
mcp-savvy/
├── AGENTS.md
├── README.md
├── Makefile                  (canonical entry point — `make help`)
├── package.json              (root, pnpm workspaces)
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── vitest.config.ts          (root vitest + coverage config)
├── .gitignore                (.* + !-allowlist pattern)
└── packages/
    ├── core/                 # shared types, errors, logger
    ├── auth/                 # OIDC + providers (planned)
    ├── storage/              # token storage (planned)
    ├── server/               # local callback server (planned)
    ├── bridge/               # stdio ↔ streamable-HTTP (planned)
    ├── cli/                  # the published `mcp-savvy` (planned)
    └── cdk/                  # CDK constructs (v0.2+)
```

Runnable deployments live under `examples/`; each example's
`example.yaml` is the source for the generated architecture catalog.

## Tool selection: cheapest tool that does the job

- **`grep_search` / `file_search` / `read_file`** — first choice for
  discovery. Faster than shell `grep`/`find`/`cat`.
- **`fs_write` / `str_replace`** — first choice for edits. Use
  `str_replace` when most of the file is unchanged. Never `sed`/`awk`
  for source edits.
- **`make` targets** — first choice for routine ops. The Makefile is
  the canonical surface for build / test / coverage / fon / clean /
  verify. Prefer `make test`, `make test-coverage`, `make verify`
  over hand-rolled `pnpm` or `rm -rf` invocations. If you need a
  one-off operation, add a documented target to the Makefile rather
  than running it inline; that way the next agent inherits the
  capability.
  - **`make help`** lists every target.
  - **`make verify`** is the pre-commit gate (clean coverage + build
    + typecheck + test + `fon check` + `architecture-check`).
  - **`make test-coverage`** clears the prior coverage report before
    running, so you don't have to `rm -rf coverage` by hand.
  - **`make architecture`** regenerates `ARCHITECTURE.md` from each
    example's `example.yaml` + `examples/_shared/architecture/overview.yaml`.
    **Never hand-edit `ARCHITECTURE.md`** — it's generated, and
    `make verify` fails on drift via `architecture-check`. To change
    it, edit the YAML (status, tagline, tools, stacks…) and rerun.
    When you add a new example, drop an `example.yaml` next to its
    README; the schemas live in the same `_shared/architecture/` dir.
- **`execute_bash`** — for tasks that genuinely need a terminal and
  don't fit a make target: `git status`, ad-hoc `pnpm view`,
  one-shot diagnostics. One command per invocation.
- **Sub-agents** — use `context-gatherer` for repository-wide
  exploration. Don't spin one up for a simple file read.

When you find yourself typing `rm -rf <build-output>`, `tsc`,
`vitest run`, or similar more than once, that's a signal: add a
target to `Makefile` and route through it. The Makefile is the
audit trail.

## Things to never do

- Never commit secrets, tokens, account IDs, deployment URLs, or any
  personal/customer identifiers. The CLI's job is to manage tokens;
  the repo itself never sees real credentials. Treat this repo as
  open-source from day one.
- Never log authorization URLs, callback correlation values, or matched
  secret bytes. Security diagnostics report only sanitized metadata.
- Never break the `.gitignore` `.*` + `!`-allowlist pattern. Add new
  dotfiles by extending the allowlist, not by removing the wildcard.
- Never introduce a native module dependency (no `keytar`, no
  `node-gyp`). The keychain layer shells out to `security` /
  `cmdkey` / `secret-tool` instead. This is deliberate — it keeps
  `npx mcp-savvy` install-free and bulletproof.
- Never change the env-var contract (`MCP_SAVVY_*`) without updating
  `.env.example`, README.md, and FEATURES.md in the same change. The
  contract is the public API for end users.
- Never call `aws configure` or mutate the user's AWS profile.
- Never run `rm -rf` against build outputs or coverage by hand —
  use `make clean`, `make clean-coverage`, or `make clean-deep`.
  Every destructive operation belongs in a documented Makefile
  target so it's auditable and reproducible.
- Never bypass the Makefile for routine ops. If a target doesn't
  exist for what you're trying to do, add it (with a `##` doc
  comment) instead of one-shotting commands.
- Never publish the CLI from a package directory or pass an npm OTP through
  Make, argv, or environment variables. Use `make publish-cli`, which runs the
  full verification gate, inspects a fresh tarball, and publishes that exact
  artifact while npm owns any interactive 2FA prompt.

## AWS

- Profile: set via `AWS_PROFILE` env var (or leave unset to use the
  default profile / env-var credentials). The Makefile passes it
  through to every example target.
- Region: **`us-east-1`**.
- All deployment work lives under `examples/` and is opt-in. v0.1
  itself does not deploy anything.

## Naming

- Package name: `mcp-savvy` (single published npm package).
- Internal scoped packages: `@mcp-savvy/core`, `@mcp-savvy/auth`,
  `@mcp-savvy/storage`, `@mcp-savvy/server`, `@mcp-savvy/bridge`,
  `@mcp-savvy/cli`, `@mcp-savvy/cdk`. The `cli` package is the one
  published to npm as `mcp-savvy`; the rest may stay private workspace
  packages bundled into the cli, or be published individually later.
- Env vars: `MCP_SAVVY_*` (uppercase, underscore-separated).
- AWS resource names in examples: `mcp-savvy-{example-name}-*`.
- CDK construct IDs: `MyMcpSavvyCognito`, etc. (pascal-case,
  prefix-free — let users pick their own ID).

## Settled public contracts

Do not change these without updating the public docs and tests in the same change:

- Default callback port: **33423**
- Token namespace: derived from issuer host + first 8 chars of clientId
- Transport: `@modelcontextprotocol/sdk` Streamable HTTP, raw
  forwarder available as fallback
- Repo shape: monorepo, pnpm workspaces
- License: MIT
- Node baseline: 20

## When in doubt

Ask before guessing. A bad public API (env-var contract, library exports,
construct shape) costs more than a slow turn — those are very hard to
change once shipped.
