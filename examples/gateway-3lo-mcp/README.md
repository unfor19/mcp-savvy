# gateway-3lo-mcp

End-to-end demo of the AgentCore Gateway 3LO (third-party OAuth) flow
through `mcp-savvy`.

## What it deploys

- **Cognito user pool** — gates the gateway with a JWT.
- **AgentCore Gateway** — exposes a GitHub OpenAPI subset
  (`getAuthenticatedUser`, `listUserRepos`) as MCP tools.
- **OAuthCompleteSessionApi** — REST API + Lambda authorizer + Lambda
  that completes the second-leg session-binding for the 3LO flow.
  Registers the bridge's loopback callback URLs as
  `AllowedResourceOAuth2ReturnUrl` on the gateway's workload identity.

## Prerequisites

A GitHub OAuth2 credential provider must already exist in AgentCore
Identity. This is a one-off setup (the provider holds an IdP-side
client secret and is shared across gateways).

```sh
# Get its ARN (replace <name>):
aws bedrock-agentcore-control list-oauth2-credential-providers \
  --query 'credentialProviders[?name==`<name>`].credentialProviderArn' \
  --output text
```

Set the ARN before deploying:

```sh
export MCP_SAVVY_GITHUB_OAUTH_PROVIDER_ARN=<arn>
```

The provider's GitHub OAuth app must have its callback URL set to
the AgentCore-issued completion endpoint
(`https://bedrock-agentcore.<region>.amazonaws.com/identities/oauth2/callback`)
— that's what AgentCore Identity expects for 3LO.

## Deploy

```sh
make example-gateway-3lo-deploy
```

## Run the smoke test

```sh
make example-gateway-3lo-add-user EMAIL=you@example.com
make example-gateway-3lo-smoke
```

The smoke test exercises the full chain: bridge → gateway →
elicitation → bridge interceptor → `completeGatewaySession(...)` →
retry → tool result.

## Tear down

```sh
make example-gateway-3lo-destroy
```

The shared GitHub credential provider is **not** destroyed — it was
provisioned out-of-band and may be reused by other gateways.
