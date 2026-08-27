# Build a Secure ChatGPT App Connected to AWS

## Goal

Build a ChatGPT App that connects to an AWS backend safely.

The app should allow ChatGPT to call a public MCP endpoint, while keeping the real business APIs, sensitive logic, and data storage private inside AWS.

The main security goal is:

> ChatGPT can call the app, but sensitive data should not be returned to the model unless explicitly required.

For sensitive data, such as a bank balance, the app should show the value inside a secure widget/iframe, while ChatGPT only receives a safe summary.

---

# 1. High-Level Architecture

## Required architecture

```text
ChatGPT
  |
  | Public HTTPS
  v
Public MCP Gateway
  - small public surface
  - validates auth
  - validates scopes
  - exposes MCP tools
  - returns safe model-visible responses
  - does not contain business logic
  |
  | Private AWS access
  v
Private AWS Backend
  - private API Gateway / Lambda / VPC services
  - real business logic
  - secure data access
  - audit logs
  - encrypted token storage
```

## Important rule

The MCP entrypoint must be public HTTPS because ChatGPT needs to reach it.

But the real backend should stay private.

---

# 2. Public vs Private Components

## Public components

These are allowed to be public, but must be heavily protected:

```text
https://chatgpt-app.example.com/mcp
https://chatgpt-app.example.com/widgets/*
```

Public components:

* CloudFront
* AWS WAF
* Public MCP endpoint
* Static widget assets
* OAuth callback endpoint, if needed

## Private components

These should not be directly exposed to the internet:

```text
Private API Gateway
Private Lambda functions
DynamoDB tables
Secrets Manager
KMS keys
Internal business APIs
Token storage
Audit logs
```

---

# 3. Recommended AWS Architecture

## Option A - Public MCP facade with private backend

Recommended initial implementation:

```text
ChatGPT
  |
  v
CloudFront
  |
  v
AWS WAF
  |
  v
Public MCP Lambda / ECS / App Runner service
  |
  v
Private API Gateway / Lambda / internal services
  |
  v
DynamoDB / Secrets Manager / KMS / business APIs
```

The public MCP service should be thin.

It should only handle:

* MCP protocol
* tool definitions
* request validation
* OAuth validation
* scope validation
* safe response shaping
* secure reference creation

It should not:

* contain business logic
* expose raw account data
* expose internal IDs
* expose access tokens
* expose refresh tokens
* expose raw provider responses

---

## Option B - CloudFront to private API Gateway

Alternative architecture:

```text
ChatGPT
  |
  v
CloudFront public domain
  |
  v
AWS WAF
  |
  v
VPC origin
  |
  v
Private API Gateway
  |
  v
Lambda / VPC services
```

Use this if the API Gateway itself must not be public.

CloudFront remains public, but API Gateway is private.

---

# 4. MCP Server Requirements

The MCP server must expose a public HTTPS endpoint:

```text
POST /mcp
GET /mcp
```

The MCP server must define tools such as:

```text
get_credit_balance_status
open_secure_balance_panel
get_transaction_summary
```

For sensitive data, tools must not return the sensitive value directly.

Bad:

```json
{
  "balance": 12340.55,
  "currency": "ILS"
}
```

Good:

```json
{
  "status": "available",
  "message": "Your credit balance is available in the secure panel."
}
```

---

# 5. Secure Widget / Iframe Pattern

For sensitive values, use a secure ChatGPT widget.

## Desired flow

```text
User asks ChatGPT:
"What is my current credit balance?"

ChatGPT calls MCP tool:
get_credit_balance_status

MCP returns:
"Balance is available in secure panel"
+ secure_view_ref in metadata

ChatGPT displays:
"I found your balance. View it in the secure panel."

Widget iframe fetches:
actual balance from AWS backend

User sees:
₪12,340.55 inside widget only
```

## Privacy boundary

```text
Model-visible:
  "Balance is available in the secure panel."

Widget-visible:
  "₪12,340.55"
```

The actual balance must not appear in:

* MCP `structuredContent`
* MCP `content`
* ChatGPT message text
* tool-call logs
* model-visible context

---

# 6. Secure View Reference Pattern

When sensitive data is requested, create a short-lived reference.

Example:

```json
{
  "secure_view_ref": "svr_abc123",
  "purpose": "credit_balance",
  "expires_in_seconds": 60,
  "single_use": true
}
```

Store this in DynamoDB.

Suggested DynamoDB table:

```text
Table: secure_view_refs

PK: ref_id
Attributes:
  user_id
  purpose
  created_at
  expires_at
  used_at
  single_use
  status
```

Rules:

* Reference must expire quickly.
* Reference should be single-use.
* Reference must be bound to the authenticated user.
* Reference must be bound to a specific purpose.
* Reference must not contain sensitive data directly.
* Reference must be deleted or marked used after successful access.

---

# 7. Example MCP Tool Behavior

## Tool name

```text
get_credit_balance_status
```

## Tool responsibility

* Validate the user.
* Validate OAuth scopes.
* Create a secure view reference.
* Return only a safe summary to ChatGPT.
* Pass the secure reference to the widget through metadata.

## Example pseudo-code

```ts
server.registerTool(
  "get_credit_balance_status",
  {
    title: "Get credit balance status",
    description:
      "Checks whether the user's credit balance is available and opens a secure panel. Do not return the raw balance to the model.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      status: z.literal("available"),
      message: z.string()
    })
  },
  async (_input, ctx) => {
    const user = await requireUser(ctx);

    await requireScope(user, "balance.read");

    const ref = await createOneTimeSecureViewRef({
      userId: user.id,
      purpose: "credit_balance",
      ttlSeconds: 60
    });

    return {
      structuredContent: {
        status: "available",
        message: "Your credit balance is available in the secure panel."
      },
      content: [
        {
          type: "text",
          text: "I found your credit balance. For privacy, view it in the secure panel."
        }
      ],
      _meta: {
        secure_view_ref: ref
      }
    };
  }
);
```

---

# 8. Widget Backend Endpoint

Create a backend endpoint that the widget calls directly.

```text
POST /secure/balance
```

## Request

```json
{
  "secure_view_ref": "svr_abc123"
}
```

## Backend validation

The endpoint must validate:

* the user is authenticated
* the reference exists
* the reference has not expired
* the reference is single-use or still valid
* the reference belongs to the same user
* the reference purpose is `credit_balance`
* the user has `balance.read`
* the request passes CSRF/session requirements if applicable

## Response

```json
{
  "balance": 12340.55,
  "currency": "ILS",
  "formatted": "₪12,340.55"
}
```

This response goes only to the widget, not to ChatGPT model context.

---

# 9. Authentication Requirements

Use OAuth/account linking.

## Required scopes

Start with narrow scopes:

```text
balance.read
transactions.summary.read
transactions.full.read
payments.create
profile.read
```

Avoid broad scopes:

```text
bank.read_all
account.full_access
```

## Scope rules

* Reading a balance requires `balance.read`.
* Reading transaction summaries requires `transactions.summary.read`.
* Reading full transaction data requires `transactions.full.read`.
* Creating a payment requires `payments.create`.
* Write actions must require explicit confirmation.

---

# 10. Public MCP Endpoint Security

The public MCP endpoint must be protected with:

## CloudFront

Use CloudFront as the public entrypoint.

Responsibilities:

* TLS termination
* request size limits
* caching only where safe
* custom headers to origin if needed
* origin protection

## AWS WAF

Enable AWS WAF with:

* rate-based rules
* managed common rule set
* known bad inputs rule set
* request body size limits
* optional geo restrictions
* bot protection if needed

## Auth validation

Every MCP request must validate:

* access token exists
* token signature is valid
* token issuer is expected
* token audience is expected
* token is not expired
* token scopes match the requested tool
* user account is still connected
* user is not disabled

## Logging

Log metadata only.

Good:

```json
{
  "user_id_hash": "abc123",
  "action": "balance_read_requested",
  "status": "success",
  "timestamp": "2026-06-10T12:00:00Z"
}
```

Bad:

```json
{
  "user_id": "user-123",
  "balance": 12340.55,
  "account_number": "123456789"
}
```

---

# 11. Internal AWS Security

## Private backend

The real backend should be private.

Use one of:

```text
Private API Gateway
Lambda inside VPC
Internal ALB
PrivateLink
VPC endpoints
```

## Internal service authentication

From the MCP facade to the backend, use:

```text
IAM auth
SigV4 signed requests
short-lived credentials
strict resource policies
VPC-only access where possible
```

## Secrets

Use:

```text
AWS Secrets Manager
AWS KMS
```

Never store OAuth secrets or API credentials in environment variables unless encrypted and tightly scoped.

## Token storage

Store user tokens encrypted.

Suggested table:

```text
Table: user_connections

PK: user_id
Attributes:
  provider
  encrypted_access_token
  encrypted_refresh_token
  scopes
  expires_at
  created_at
  updated_at
  status
```

Use KMS encryption for sensitive fields.

---

# 12. Widget CSP Requirements

The widget iframe must only be allowed to connect to approved domains.

Allowed domains should be minimal.

Example:

```text
connect-src:
  https://api.example.com

resource-src:
  https://assets.example.com

frame-src:
  none unless explicitly needed
```

Rules:

* Do not allow `*`.
* Do not allow unnecessary third-party domains.
* Do not allow nested iframes unless required.
* Do not send sensitive widget state back to the model.
* Do not call model-context update APIs with sensitive values.

---

# 13. Data Exposure Rules

## Never return these to ChatGPT

```text
access tokens
refresh tokens
account numbers
card numbers
full transaction lists by default
internal customer IDs
raw provider API responses
risk scores
backend errors with stack traces
SQL queries
debug payloads
KMS keys
Secrets Manager values
```

## Safe to return to ChatGPT

```text
operation status
non-sensitive summaries
next-step instructions
generic error messages
confirmation that data is available in secure panel
```

## Sensitive data handling

For sensitive data, prefer:

```text
secure widget display
explicit user confirmation
short-lived secure references
minimum necessary data
```

---

# 14. Required AWS Resources

## Public edge

* Route 53 hosted zone
* ACM certificate
* CloudFront distribution
* AWS WAF WebACL
* Public domain, for example:

```text
chatgpt-app.example.com
```

## MCP service

Choose one:

```text
Lambda + API Gateway
Lambda Function URL behind CloudFront
ECS Fargate behind ALB
App Runner
```

Recommended for first version:

```text
Lambda + API Gateway or ECS/App Runner
```

Use ECS/App Runner if streaming or long-running MCP behavior becomes annoying in Lambda.

## Private backend

* Private API Gateway or internal service
* Lambda business handlers
* DynamoDB
* KMS
* Secrets Manager
* CloudWatch Logs
* CloudTrail

## Storage

Required DynamoDB tables:

```text
user_connections
secure_view_refs
audit_logs
```

Optional tables:

```text
user_preferences
consent_records
tool_invocations
```

---

# 15. Required Endpoints

## Public

```text
/mcp
/widgets/balance
/oauth/start
/oauth/callback
```

## Private or protected

```text
/secure/balance
/internal/balance-summary
/internal/create-secure-view-ref
/internal/audit
```

---

# 16. Development Process

## Step 1 - Local MCP server

Build a local MCP server with one fake tool:

```text
get_credit_balance_status
```

Return only a safe response.

No real AWS yet.

## Step 2 - Test with MCP Inspector

Verify:

```text
tool appears
tool schema is valid
tool call works
response shape is correct
no sensitive data is returned
```

## Step 3 - Build basic widget

Create a simple widget:

```text
"Balance available"
"Reveal securely"
```

Initially use fake data.

## Step 4 - Add secure_view_ref

Implement:

```text
create secure reference
store in DynamoDB
return reference in metadata
widget fetches using reference
```

## Step 5 - Add AWS backend

Add:

```text
API Gateway
Lambda
DynamoDB
KMS
Secrets Manager
CloudWatch
```

## Step 6 - Add OAuth/account linking

Implement:

```text
OAuth login
consent screen
token exchange
token refresh
scope validation
disconnect handling
```

## Step 7 - Add HTTPS public endpoint

Expose only the MCP facade publicly.

Use:

```text
CloudFront
AWS WAF
custom domain
ACM certificate
```

## Step 8 - Connect to ChatGPT developer mode

In ChatGPT:

```text
Settings
Apps & Connectors
Advanced settings
Developer mode
Create connector
Add MCP URL
```

Use:

```text
https://chatgpt-app.example.com/mcp
```

## Step 9 - Test in ChatGPT

Test prompts:

```text
What is my current credit balance?
Show my available credit.
Do I have a balance available?
```

Expected behavior:

```text
ChatGPT calls MCP tool
MCP returns safe message only
Widget appears
Widget fetches actual value directly
ChatGPT never receives raw balance
```

---

# 17. Testing Checklist

## Privacy tests

Verify that sensitive values do not appear in:

```text
ChatGPT response text
MCP structuredContent
MCP content array
tool-call logs
CloudWatch logs
frontend console logs
analytics events
error messages
```

## Security tests

Verify:

```text
expired secure_view_ref fails
used secure_view_ref fails
ref for another user fails
missing OAuth token fails
missing scope fails
invalid token fails
replayed request fails
oversized request fails
unexpected tool input fails
```

## Backend tests

Verify:

```text
private backend is not publicly reachable
DynamoDB data is encrypted
tokens are encrypted with KMS
WAF blocks suspicious requests
CloudFront only forwards required paths
logs do not contain secrets
```

## Widget tests

Verify:

```text
widget fetches only approved domains
CSP blocks unknown domains
widget does not send balance back to model
widget handles expired reference
widget handles auth failure
widget shows safe error messages
```

---

# 18. Error Handling

Use safe error messages.

Bad:

```text
Failed to call core banking API for account 123456789.
```

Good:

```text
I could not retrieve the balance right now. Please try again later.
```

Bad:

```json
{
  "error": "Token expired: eyJhbGciOi..."
}
```

Good:

```json
{
  "error": "AUTH_EXPIRED",
  "message": "Please reconnect your account."
}
```

---

# 19. Write Actions

If adding payment or transfer tools later, write actions must be treated differently.

Required behavior:

```text
User asks to create payment
MCP prepares payment
ChatGPT asks for confirmation
User confirms
MCP executes payment
Result is returned safely
```

Never execute financial write actions silently.

Required scopes:

```text
payments.create
payments.approve
```

Required audit fields:

```text
user_id_hash
action
amount
currency
destination_hash
timestamp
confirmation_id
status
```

Do not log full destination details unless legally required.

---

# 20. MVP Scope

## MVP should include

```text
one MCP server
one tool: get_credit_balance_status
one secure widget
one fake balance endpoint
one secure_view_ref table
basic OAuth mock or dev auth
CloudFront + WAF
safe logging
```

## MVP should not include yet

```text
real banking integration
payments
full transactions
long-lived sensitive sessions
complex permissions
multi-account support
production OAuth
```

---

# 21. Production Scope

Before production, add:

```text
real OAuth/account linking
real scope enforcement
token encryption
audit logs
security review
penetration testing
rate limits
WAF tuning
incident monitoring
admin disconnect controls
privacy policy
terms of service
data retention policy
user data deletion flow
```

---

# 22. Success Criteria

The implementation is successful when:

```text
ChatGPT can call the MCP endpoint
The backend business API is not public
The widget renders in ChatGPT
The actual balance is visible only in the widget
The actual balance is never returned to the model
OAuth scopes are enforced
secure_view_ref expires and is single-use
CloudWatch logs contain no sensitive data
WAF and rate limits are enabled
private APIs cannot be accessed from the public internet
```

---

# 23. Final Recommended Implementation

Build this:

```text
ChatGPT
  |
  v
CloudFront + WAF
  |
  v
Public MCP facade
  |
  v
Private AWS backend
  |
  v
Secure data services
```

For sensitive values:

```text
MCP returns:
  safe status only

Widget fetches:
  sensitive data directly

Model sees:
  no raw sensitive data
```

This is the desired safe architecture for a ChatGPT App connected to AWS.
