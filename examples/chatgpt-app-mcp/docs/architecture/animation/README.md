# Pattern D animation

A [Remotion](https://www.remotion.dev/) project that animates the
request flow through the deployed `chatgpt-app-mcp` Pattern D
architecture: ChatGPT → WAF → API Gateway → Lambda → DynamoDB and
back.

This subdirectory is **not** a pnpm workspace member (no glob in
[`pnpm-workspace.yaml`](../../../../../pnpm-workspace.yaml)
covers `examples/*/docs/...`), so installing here does not pull
Remotion's dependency tree (~600 MB) into the rest of the repo.

## Render via the Makefile (recommended)

From the repo root:

```sh
make example-chatgpt-app-animation-render   # one-time install + h.264 mp4
make example-chatgpt-app-animation-gif      # one-time install + animated GIF
make example-chatgpt-app-animation-studio   # live preview at http://localhost:3000
```

Output lands in `out/pattern-d.mp4` (or `.gif`). Both are
gitignored.

## Render directly

```sh
cd examples/chatgpt-app-mcp/docs/architecture/animation
pnpm install --ignore-workspace        # npm install also works
pnpm render                            # mp4
pnpm run render:gif                    # animated gif
pnpm studio                            # live editor
```

## What the animation shows

| Frame range | Scene                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 0 – 105     | Title card.                                                                                                                              |
| 90 – 240    | Architecture components fade in (Client, WAF, API Gateway, Lambda, DDB, Cognito).                                                        |
| 240 – 330   | OAuth side-call: Client ↔ Cognito → access_token.                                                                                        |
| 380 – 560   | MCP request: Bearer JWT travels Client → WAF → API Gateway → Lambda; API GW pulses while the Cognito Authorizer + Request Validator run. |
| 580 – 660   | Lambda → `customer_data` (`GetItem`).                                                                                                    |
| 670 – 730   | Lambda → `audit_log` (append-only `PutItem`).                                                                                            |
| 750 – 870   | Response packet returns: `structuredContent { status, currency }`.                                                                       |
| 800 – 900   | Privacy-boundary callout: amount lives in `_meta`, never `structuredContent`.                                                            |

Total: 930 frames at 30 fps = 31 seconds, 1920×1080.

## Customising

- **Frame anchors** live in `src/PatternD.tsx` as the `F` const.
- **Spatial layout** lives in `src/layout.ts`. `nodes` defines
  card positions, `paths` defines the polylines packets travel.
- **Theme** lives in `src/theme.ts` (palette + accents + fonts +
  card sizes).

To add Pattern C as a second composition:
1. Add a new node + path set to `src/layout.ts`.
2. Copy `src/PatternD.tsx` to `src/PatternC.tsx`, retune the
   frame anchors, swap in the C-specific labels.
3. Register it in `src/Root.tsx` next to `PatternD`.
4. Run `pnpm render src/index.ts PatternC out/pattern-c.mp4`.
