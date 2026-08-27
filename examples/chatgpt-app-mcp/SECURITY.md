# `chatgpt-app-mcp` — Security

This example deploys a **demonstration** of a banking-grade ChatGPT
App: synthetic data, the secure-widget pattern, and enough boundary
controls to plausibly answer *"is the user's balance leaking to the
model?"* with **no**.

It is **not** a production-ready banking integration. This file
documents what's enabled in the MVP, what's available as opt-in
hardening, and what's deliberately out of scope.

For project-wide security context (CLI token handling, CDK
constructs hardening), see the top-level [`SECURITY.md`](../../SECURITY.md).

---

## 1. What MVP defends against

The example deploys privacy + security boundaries at four layers; each is
testable end-to-end.

### 1.1 Privacy boundary — the model never sees the balance

| Layer                | What's enforced                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool result envelope | `structuredContent` carries only `{ status, currency }`; `content` is one safe sentence; `_meta` (widget-only) carries the `secure_view_ref`. |
| Widget endpoint      | Returns the actual `{ balance, currency, formatted }` only to the iframe — never reaches the model context.                                   |
| Secure-view-ref      | Bound to `user_sub_hash` + `purpose`, 60-second DynamoDB TTL **and** single-use (conditional `UpdateItem`). Second redeem returns 410.        |
| Logs                 | `audit_log` table records `user_sub_hash` (SHA-256), `action`, `correlation_id`, `status`, `timestamp`. **Never** raw amounts or `sub`.       |

### 1.2 Authorization boundary — every call is authenticated

| Layer                       | What's enforced                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Cognito user pool           | MFA = TOTP required; public PKCE client (no client secret); MFA enforced on the Hosted UI sign-in.               |
| MCP Lambda JWT verification | Issuer + audience (Cognito's `client_id` claim accepted as audience surrogate) + exp/nbf + scopes + `sub`.       |
| Scope check                 | `get_credit_balance_status` requires the `balance.read` scope; widget endpoint same. Reject without a clear 401. |
| Re-auth on widget           | Widget POST carries the same Bearer token; Lambda re-validates. No "the iframe is implicitly authorized."        |

### 1.3 Network boundary — one managed public ingress

| Layer                    | What's enforced                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| Regional REST API domain | The custom domain is public; the default `execute-api` endpoint is disabled.                    |
| API Gateway authorizer   | Cognito validates authenticated routes and enforces the required OAuth scope before invocation. |
| API Gateway validator    | A request model rejects malformed JSON-RPC envelopes before Lambda.                             |
| Lambda VPC config        | Private isolated subnets only. No internet gateway or NAT gateway.                              |
| VPC endpoints            | Logs interface endpoint and DynamoDB gateway endpoint.                                          |

The synthesized topology can be checked for a disabled default API endpoint,
private-isolated Lambda subnets, and route tables without an internet or NAT route.

### 1.4 Data-at-rest boundary — encrypted with AES-256

| Layer                        | What's enforced                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| DynamoDB encryption          | AWS-managed key (default `aws/dynamodb`). AES-256, FIPS 140-2 validated, automatic.    |
| DynamoDB PITR                | Point-in-time recovery enabled on all three tables.                                    |
| DynamoDB deletion protection | Enabled — accidental `aws dynamodb delete-table` is rejected.                          |
| `audit_log` table IAM        | Lambda role grants `PutItem` only — no `Update*`, no `Delete*`. Append-only by design. |

### 1.5 Request boundary — regional WAF before Lambda

| Layer                                  | What's enforced                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `AWSManagedRulesCommonRuleSet`         | OWASP Top 10-ish defaults (SQLi, XSS, traversal).                                                                     |
| `AWSManagedRulesKnownBadInputsRuleSet` | Known-malicious payloads.                                                                                             |
| Rate-based rule                        | 200 req / 5 min / IP. Anyone hitting that ceiling is blocked at the edge for 5 min.                                   |
| Explicit body-size rule                | Reject request bodies larger than 16 KiB.                                                                            |
| Lambda reserved concurrency            | Fixed at 10, so downstream systems retain a compute blast-radius cap.                                                 |

---

## 2. Available hardening (opt-in upgrades)

These add cost, complexity, or both. Each is a documented one-direction upgrade — no need to redo MVP work.

### 2.1 Edge

- **CloudFront or another controlled edge.** Migrate to a documented edge pattern when transport-level client controls or an additional origin boundary are required. This is a topology change, not a switch in the deployed example.
- **Geo-blocking.** Add a WAF rule blocking the geographies you don't serve. Free; per-WAF-rule pricing.
- **ChatGPT egress IP allowlist.** OpenAI publishes [their egress IP ranges](https://developers.openai.com/api/docs/guides/ip-addresses); a WAF rule can require source IP ∈ that list. **Trade-off:** breaks local dev.
- **AWS Shield Advanced.** Real DDoS protection ($3K/month + cost-protection guarantee). Not appropriate for an OSS demo.

### 2.2 Identity

- **Cognito Advanced Security Features (ASF).** Adaptive auth, compromised-credentials check, anomalous-IP scoring. ~$0.05/MAU. Big "banking-grade" signal at near-zero cost for a small user base.
- **Pre-token-generation Lambda trigger** on Cognito. Inject custom claims (e.g. a `jti` for replay tracking, or a per-tenant claim).
- **`SignInPolicy` hardening.** Disallow case-insensitive email matching, require email verification, password length ≥ 12, no SMS MFA. Defaults are decent; tighten for banking.

### 2.3 API surface

- **Private API Gateway behind a controlled edge.** Migrate to Pattern C when a private API endpoint is required. The current Regional REST API already provides request validation, WAF, and Cognito authorization.
- **API Gateway HTTP API + JWT authorizer** (Cognito only). Cheaper than REST API, but Cognito-only and no `endpointType: PRIVATE`. Skip.

### 2.4 Encryption

- **Customer-managed KMS CMK on DynamoDB.** Replace the default `aws/dynamodb` key with a CMK you own. Gives you key policy control, per-call CloudTrail audit, manual rotation cadence. **~$1/month per key** + `kms` interface VPCE if Lambda calls KMS directly (`~$15/month` × 2 AZs).
- **`kms` VPC interface endpoint.** Required if you flip to CMK and want `kms` calls to stay in-VPC.
- **AWS CloudHSM-backed CMK.** For regulated tenants that can't trust AWS-managed HSMs. Bigger lift.

### 2.5 Audit

- **CloudTrail data events** on `customer_data`, `secure_view_refs`, `audit_log`, and KMS CMK. Per-`GetItem` / `Decrypt` records. ~$0.10 per 100K events. Demo volume is pennies; real-traffic volume requires planning.
- **Dedicated audit S3 bucket with object lock** for the CloudTrail data events trail. Compliance baseline for tamper-resistant audit.
- **VPC Flow Logs** to CloudWatch Logs or S3. High volume; useful for incident response.
- **AWS GuardDuty** (account-wide). Continuous threat detection. Not example-specific — turn it on at the account level.

### 2.6 Network (least-privilege per VPC endpoint)

- **VPC endpoint policies.** Each interface/gateway endpoint accepts a policy document. Lock down by IAM principal + action + resource:
  - `logs` VPCE: only `logs:CreateLogStream` + `logs:PutLogEvents` on the Lambda's own log group.
  - DynamoDB gateway endpoint: only the example's tables (`Resource: arn:aws:dynamodb:...:table/...`).
- **AWS Network Firewall.** Subnet-to-subnet deep packet inspection. ~$400/month per endpoint. Overkill for one Lambda.
- **NACLs at the subnet level.** Extra layer beyond security groups; defense in depth.

### 2.7 Compute

- **Lambda code signing** via [AWS Signer](https://docs.aws.amazon.com/signer/latest/developerguide/Welcome.html). Lambda only runs code signed by your specified profile. Friction for OSS CI; useful in production.
- **Lambda Provisioned Concurrency.** Eliminates cold starts (~$0.0000041667/GB-second + reserved-allocation hours). For latency-sensitive routes.
- **Tune Lambda reserved concurrency.** The example defaults to 10; production capacity planning may justify a different explicit cap.
- **Lambda execution environment audit.** `lambda:GetFunctionConfiguration` + AWS Config rules to detect drift on env vars, role, VPC config.

### 2.8 Detection / governance

- **AWS Security Hub.** Account-wide compliance dashboard. Not example-specific.
- **AWS Config rules.** Drift detection: e.g. *"all DynamoDB tables in this stack must have PITR"*, *"Lambda functions must have `vpc_config`."*
- **Amazon Inspector.** Continuous vulnerability scanning of Lambda dependencies and container images.
- **CloudWatch alarms.** Auth failures > N/min, Lambda errors > N, throttles > N. Required for incident response.
- **WAF logs to CloudWatch Logs / S3.** Analyze blocked requests, tune rules over time.

---

## 3. Out of scope (for the OSS demo)

These would matter for a real production banking deployment but are out of scope for a public example:

- Real banking integration (KYC, fraud scoring, payment rails).
- Multi-region active-active deployment with DynamoDB Global Tables.
- AWS Shield Advanced ($3K/month) and its DDoS cost-protection guarantee.
- AWS Network Firewall ($400/month per endpoint).
- CloudHSM-backed customer keys.
- ChatGPT-app submission to the public store (compliance review process).
- FedRAMP / SOC2 / PCI-DSS-specific control mappings (this example is a developer-mode connector demo).

---

## 4. Reporting an issue

For any security-relevant issue with this example, see the project-wide
[`SECURITY.md`](../../SECURITY.md) reporting process. Do **not** open a
public GitHub issue.
