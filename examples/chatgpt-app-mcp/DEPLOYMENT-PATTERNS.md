# Deployment patterns for `chatgpt-app-mcp`

There's no single "right" architecture for shipping a protected
MCP server backed by Lambda. The choice depends on what your
auditor, latency budget, and idle-cost tolerance look like. This
document captures the patterns we considered for this example,
what each gives you, what each costs, and when to pick which.

---

## Quick comparison

| Pattern                                                                   | Idle $/mo | Stacks | Auth lives at                      | Public DNS for app endpoints                    | When to pick                                                                                            |
| ------------------------------------------------------------------------- | --------- | ------ | ---------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **A.** CloudFront + ALB + Lambda                                          | ~$45      | 5      | Lambda (`auth.mjs`, hand-rolled)   | CloudFront only                                 | Demos, prototypes, projects without compliance auditors                                                 |
| **B.** CloudFront + Public API Gateway + Lambda                           | ~$10      | 4      | API Gateway (managed, declarative) | CloudFront + API Gateway custom domain          | Internet-facing APIs that benefit from CloudFront's edge layer                                          |
| **C.** CloudFront + ALB + execute-api VPCE + Private API Gateway + Lambda | ~$45      | 5      | API Gateway (managed, declarative) | CloudFront only — API Gateway has no public DNS | Banking, healthcare, regulated environments where "no public DNS for the API" is an auditable property  |
| **D.** Public API Gateway + Lambda (no CloudFront)                        | ~$20      | 4      | API Gateway (managed, declarative) | API Gateway custom domain                       | Simple internet-facing APIs that don't need edge presence — the most straightforward managed-auth shape |

---

## Pattern A — CloudFront + ALB + Lambda (auth in Lambda)

```
ChatGPT
  │  Authorization: Bearer <Cognito access token>
  ▼
CloudFront + WAF                        rate limit, size cap, managed rules
  │
  ▼  CloudFront prefix-list SG          network-level access control
ALB (private)
  │
  ▼  direct integration
Lambda  ── auth.mjs::verifyToken        JWT verification + scope check + audit
  │
  ▼  DynamoDB Gateway endpoint
DynamoDB
```

**Strengths:**
- Simplest viable design. Lambda is the only place auth lives.
- Reserved concurrency caps the blast radius of an auth-flood attack.
- Defense in depth: WAF → SG ingress prefix list → JWT check → IAM grants.

**Weaknesses:**
- Auth is hand-rolled JS. Auditors reading `auth.mjs` have to trust
  ~170 lines of jose calls. Mitigated somewhat by lifting the
  canonical implementation from `packages/cdk/src/lambdas/jwt-authorizer/`,
  which is shared across other examples in this repo.
- No declarative request-body schema validation.
- Lambda burns compute on every junk request, returning 401 only
  after JWKS fetch + signature verify (~30-150ms cold).

---

## Pattern B — CloudFront + Public API Gateway + Lambda

```
ChatGPT
  │  Authorization: Bearer <Cognito access token>
  ▼
CloudFront + WAF
  │  origin custom header: x-cf-secret: <from Secrets Manager>
  ▼  HTTPS to API Gateway custom domain
Public API Gateway (Regional)            execute-api default endpoint disabled
  │  Resource policy: deny without x-cf-secret
  │  Cognito User Pool Authorizer
  │  Request Validator (JSON-RPC schema)
  ▼  proxy integration
Lambda  (in VPC for DynamoDB GW endpoint, otherwise no VPC needed)
  │
  ▼
DynamoDB
```

**Strengths:**
- Managed authentication. The auditor's "where's the auth code?"
  question is answered with "there isn't any — here's the CDK
  config that wires the AWS-managed Cognito authorizer."
- Declarative request-body schema validation (`RequestValidator`
  + JSON Schema model). Malformed JSON-RPC envelopes are rejected
  before Lambda runs.
- Separate CloudWatch log group for auth/access decisions.
- CloudFront's edge layer is in front of the regional API Gateway —
  edge WAF + Shield Standard, edge TLS termination.
- Stable public URL (CloudFront domain) even across full API
  Gateway rebuilds.

**Weaknesses:**
- API Gateway is publicly DNS-resolvable. The `<api-id>.execute-api`
  default endpoint can be disabled, but the custom-domain alias
  remains internet-reachable. The defense layers stop unauthenticated
  requests, but the *DNS record* exists.
- The CloudFront-secret-header pattern adds a rotation surface. The
  secret lives in Secrets Manager and needs a periodic rotation
  routine (Make target).
- Two layers of TLS termination (edge + regional) and two layers of
  auth-adjacent logic (CloudFront WAF + API Gateway authorizer)
  means more places where a misconfiguration can hide.

---

## Pattern C — CloudFront + ALB + execute-api VPCE + Private API Gateway + Lambda

> Reference: AWS blog,
> [Accessing private Amazon API Gateway endpoints through custom
> Amazon CloudFront distribution using VPC Origins](https://aws.amazon.com/blogs/compute/accessing-private-amazon-api-gateway-endpoints-through-custom-amazon-cloudfront-distribution-using-vpc-origins/)
> (Sept 2025).

```
ChatGPT
  │  Authorization: Bearer <Cognito access token>
  ▼
CloudFront + WAF
  │  origin custom header: x-apigw-api-id: <api-id from Fn::ImportValue>
  ▼  CloudFront VPC origin
ALB (private)
  │  IP target group: targets = execute-api VPCE ENI private IPs
  ▼
execute-api VPC interface endpoint        only the ALB SG can reach it
  │
  ▼
Private API Gateway (REST)               endpointTypes: PRIVATE
  │  Resource policy: aws:sourceVpce == <our VPCE>
  │  Cognito User Pool Authorizer
  │  Request Validator (JSON-RPC schema)
  ▼  proxy integration
Lambda  (in VPC, surgical IAM)
  │
  ▼  DynamoDB Gateway endpoint
DynamoDB
```

**Strengths:**
- All the managed-auth wins of Pattern B (declarative authorizer,
  request validator, separate auth audit log).
- **API Gateway has no public DNS.** The default endpoint resolves
  only inside the VPC, only via the configured VPCE. The auditor's
  "is this endpoint reachable from the internet?" question gets a
  clean "no, here's the resource policy with `aws:sourceVpce == X`."
- Network-level isolation layered on top of all the managed-auth
  controls. Even if the resource policy were misconfigured, the API
  Gateway has no DNS to attempt to resolve.

**Weaknesses:**
- Idle cost ~$45/mo. Two interface VPCEs at $7/mo each (cognito-idp
  + logs), one execute-api VPCE at $7/mo, the ALB at $16/mo.
- Most moving parts of any pattern. Five stacks. An ENI IP resolution
  custom resource (`AwsCustomResource` calling
  `ec2:DescribeNetworkInterfaces` to map the VPCE's ENIs to ALB IP
  targets). An origin custom header (`x-apigw-api-id`) so the VPCE
  knows which private API to route to.
- App ↔ Edge cross-stack cycle (`App.publicUrl ← Edge.viewerUrl` AND
  `Edge.x-apigw-api-id ← App.api.restApiId`) has to be broken via
  env-driven public URL + `Fn.importValue` for one-way deploy
  ordering. First deploy is two-pass (deploy → capture URL → set
  env var → redeploy).

---

## Pattern D — Public API Gateway + Lambda (no CloudFront)

```
ChatGPT
  │  Authorization: Bearer <Cognito access token>
  ▼  HTTPS to API Gateway custom domain
Public API Gateway (Regional)            execute-api default endpoint disabled
  │  WAF WebACL (regional): managed rules + rate limit + body size cap
  │  Cognito User Pool Authorizer
  │  Request Validator (JSON-RPC schema)
  ▼  proxy integration
Lambda  (in VPC, private-isolated subnets, logs VPCE + DynamoDB GW endpoint)
  │
  ▼
DynamoDB
```

**Strengths:**
- Simplest managed-auth shape. Four stacks — Data, Cognito, Network,
  App. The App stack owns the API Gateway, WAF, custom domain,
  Route 53 alias, and the Lambda in one place.
- All the managed-auth wins of Pattern B (Cognito User Pool
  Authorizer, Request Validator, per-stage access logs) without
  the App ↔ Edge plumbing.
- Cheaper than B / C. ~$20/mo idle (WAF + 1 interface VPCE for
  CloudWatch Logs; the DynamoDB Gateway endpoint is free).
- Public URL is the API Gateway custom domain — `chatgpt-app-mcp.example.com`
  rather than a CloudFront sandbox-style URL.
- **Lambda runs in a VPC by design.** Strictly, Pattern D doesn't
  need a VPC for our DynamoDB-only data tier. The Lambda lives in
  one anyway because that's what a real banking deployment looks
  like — the same function would be querying private RDS / Aurora,
  internal microservices, or a VPC-only API. Building the demo with
  Lambda outside the VPC would tell a thinner story.

**Weaknesses:**
- No edge layer. Single regional endpoint; clients in distant
  regions take a longer TLS handshake. For server-to-server traffic
  (ChatGPT → MCP) this is invisible; for end-user-facing widgets
  served from this same domain it would matter.
- DNS for the API Gateway points directly at AWS's regional endpoint.
  Some compliance reviewers prefer to see CloudFront in front.
- No fallback for "swap origin during incident response" without
  CloudFront in the path.

---

## How to choose

A short flowchart:

1. **Is "no public DNS for the API" a real auditor requirement?**
   - Yes → Pattern C.
   - No → continue.
2. **Does the auditor care about hand-rolled vs managed authentication code?**
   - Yes → Pattern B or D.
   - No → Pattern A is fine.
3. **Do you need an edge layer (CloudFront) — for global users, geo
   restrictions, edge WAF, Shield Advanced, or stable URL across
   API Gateway rebuilds?**
   - Yes → Pattern B.
   - No → Pattern D.

For a **regional production banking deployment** of this exact shape:
the answer is C. For a **regional production fintech / e-commerce /
SaaS deployment that wants a CloudFront edge**: the answer is B. For
a **simple managed-auth deployment without edge needs**: the answer
is D. For **anything inside an AWS account where compliance isn't
a thing**: the answer is A.

---

## A note on idle cost

The cost difference between the patterns mostly comes from the
network components:

- ALB: $16/mo per load balancer.
- Interface VPC endpoints: $7/mo per endpoint per AZ. Pattern C
  uses three (`cognito-idp`, `logs`, `execute-api`); Patterns A and
  B use two (`cognito-idp`, `logs`); Pattern D uses none.
- WAF Web ACL: $5/mo per Web ACL plus rule charges.
- CloudFront: pay-per-request, ~$0 idle.
- API Gateway: pay-per-request, ~$0 idle.
- Lambda + DynamoDB on-demand: ~$0 idle.

For a real production deployment, the cost difference is rounding
error. For an OSS demo running in a sandbox account, it's the
actual floor — Pattern D costs ~10× less than Pattern C.
