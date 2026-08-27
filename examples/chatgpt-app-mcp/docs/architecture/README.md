# Architecture diagrams

Mermaid diagrams for each deployment pattern in
[`../../DEPLOYMENT-PATTERNS.md`](../../DEPLOYMENT-PATTERNS.md). One
file per pattern. The pattern letter matches that document.

| File             | Pattern | Shape (one-liner)                                                                | Notes                                                           |
| ---------------- | ------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [`d.mmd`](d.mmd) | **D**   | Public Regional API Gateway + Lambda (no CloudFront, no ALB).                    | **Currently deployed** by `bin/app.ts`.                         |
| [`c.mmd`](c.mmd) | **C**   | CloudFront + internal ALB + execute-api VPCE + **Private** API Gateway + Lambda. | **Banking-grade** — recommended for regulated workloads.        |
| [`a.mmd`](a.mmd) | A       | CloudFront + internal ALB + Lambda (auth in Lambda, no API Gateway).             | Reference / demo shape. Auth lives in `auth.mjs` in the Lambda. |
| [`b.mmd`](b.mmd) | B       | CloudFront + Public Regional API Gateway + Lambda.                               | Edge layer with managed auth and CloudFront secret header.      |

For an animated walkthrough of Pattern D (the deployed shape), see
the [Remotion project](animation/README.md) under `animation/`.
Render with `make example-chatgpt-app-animation-render`; output
lands at `animation/out/pattern-d.mp4`.

## Render

GitHub renders Mermaid in fenced ` ```mermaid ` blocks but not in
raw `.mmd` files. To view a single pattern:

```sh
# Live preview locally:
npx -p @mermaid-js/mermaid-cli mmdc -i d.mmd -o /tmp/d.svg && open /tmp/d.svg

# Or paste the file contents into https://mermaid.live
```

To embed in another markdown file:

```markdown
```mermaid
<contents of d.mmd>
` ` `
```

## Deployed pattern

The example and its top-level README use **Pattern D**:

- `infra/bin/app.ts` opens with the comment *"Four-stack topology
  (Pattern D — see DEPLOYMENT-PATTERNS.md)"*.
- Only four stack files exist: `data-stack.ts`, `cognito-stack.ts`,
  `network-stack.ts`, `app-stack/`.
- `app-stack/api.ts` builds a public regional REST API with a
  Cognito User Pool Authorizer + Request Validator + regional WAF
  + custom domain. No CloudFront, no ALB.

Patterns C, A, and B remain documented alternatives in
`DEPLOYMENT-PATTERNS.md`; they are not the deployed example.
