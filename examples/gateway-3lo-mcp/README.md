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

You need:

- Node.js 20 or newer and `pnpm`.
- AWS CLI v2 with the `bedrock-agentcore-control` commands.
- An authenticated AWS profile with permission to deploy the listed resources.
- A GitHub OAuth App that you own.

Set and verify the target before creating anything:

```sh
export AWS_PROFILE=<profile>
export AWS_REGION=<region>
aws sts get-caller-identity --profile "$AWS_PROFILE"
pnpm install --frozen-lockfile
```

This example also requires a matching GitHub OAuth2 credential provider in
AgentCore Identity. The CDK app intentionally accepts only the provider ARN;
it never reads or deploys the GitHub client secret. Create the provider once
in the same AWS account and region as the example, then reuse it.

### Create the GitHub OAuth2 credential provider

1. Create a GitHub OAuth App in GitHub's **Settings → Developer settings →
   OAuth Apps**. Its callback is replaced in step 5 with the unique URL issued
   by AgentCore.
2. Generate a client secret for the OAuth App. Do not commit it, add it to an
   `.env` file, or pass it to this example.
3. Create the provider through the AgentCore Identity API or CLI, not IAM's
   **Identity providers** page. To avoid putting the secret in shell history,
   use the AWS CLI's interactive prompt:

   ```sh
   aws bedrock-agentcore-control \
     create-oauth2-credential-provider --region "$AWS_REGION" \
     --name <name> --credential-provider-vendor GithubOauth2 \
     --cli-auto-prompt
   ```

   For `oauth2ProviderConfigInput`, select
   `githubOauth2ProviderConfig` and enter:

   - Client ID: the GitHub OAuth App client ID
   - Client secret: the GitHub OAuth App client secret

4. Copy the `callbackUrl` from the create response. AgentCore issues a unique
   URL for each provider, including a provider-specific suffix:

   ```text
   https://bedrock-agentcore.<region>.amazonaws.com/identities/oauth2/callback/<provider-id>
   ```

5. Replace the GitHub OAuth App's authorization callback URL with that exact
   `callbackUrl` and save the app. The unsuffixed regional callback URL is not
   sufficient for newly created providers.

See the current AWS procedure in
[Configure GitHub as an outbound credential
provider](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity-idp-github.html).

If a matching provider already exists, reuse it. Get its ARN and callback URL
(replace `<name>`):

```sh
aws bedrock-agentcore-control get-oauth2-credential-provider \
  --region "$AWS_REGION" --name <name> \
  --query '{arn:credentialProviderArn,callbackUrl:callbackUrl}'
```

Export the ARN for every example command:

```sh
export MCP_SAVVY_GITHUB_OAUTH_PROVIDER_ARN=<arn>
```

### Agent-assisted end-to-end prompt

Copy this prompt into an agent that has local AWS access. Replace the
placeholders, but never put the GitHub client secret in the prompt.

```text
Set up, deploy, and validate the gateway-3lo-mcp example end to end.

- AWS profile: <profile>
- AWS region: <region>
- Provider name: <provider-name>
- GitHub OAuth client ID: <client-id>
- Cognito test-user email: <email>

Read this README and the named Make targets before acting. Verify the AWS
account and region with sts get-caller-identity, install the locked workspace
dependencies, and check for an exact-name provider before creating one. Reuse
an existing provider instead of creating a duplicate.

If creation is required, request the GitHub client secret through a hidden
local prompt. Never ask me to paste it into chat, print it, put it in a command
argument, or write it to disk or the repository. Create a GithubOauth2
credential provider through AgentCore Identity and capture its non-secret ARN
and unique callbackUrl. Have me save that exact callbackUrl on the GitHub OAuth
App, then read the provider back from AWS.

Export AWS_PROFILE, AWS_REGION, and MCP_SAVVY_GITHUB_OAUTH_PROVIDER_ARN. Check
whether CDKToolkit exists; if it does not, explain the bootstrap resources and
ask before running make example-gateway-3lo-bootstrap. Run the synth and diff
targets, summarize the exact stacks and cost-bearing services, and ask for my
explicit approval before make example-gateway-3lo-deploy.

After deployment, run example-gateway-3lo-config, create the Cognito test user,
and run example-gateway-3lo-smoke. Be precise: that smoke test proves login,
MCP initialization, and tools/list only. To prove the full 3LO flow, prepare
the MCP client configuration including MCP_SAVVY_COMPLETE_SESSION_URL, have me
invoke both GitHub tools, complete GitHub consent, and verify that both calls
return real GitHub results. Do not claim end-to-end success before that passes.

Finally, report what remains deployed and the exact logout, stack-destroy, and
optional credential-provider cleanup commands. Never destroy a shared provider
without separate confirmation.
```

## Deploy

Bootstrap the target account and region once, then inspect the synthesized
template and live diff before deploying:

```sh
make example-gateway-3lo-bootstrap
make example-gateway-3lo-synth
make example-gateway-3lo-diff
make example-gateway-3lo-deploy
make example-gateway-3lo-config
```

The deploy creates the two stacks listed above and can incur AWS usage costs.
`deploy` runs with `--require-approval=never`, so treat the preceding `diff` as
the approval gate.

## Run the smoke test

```sh
make example-gateway-3lo-add-user EMAIL=you@example.com
make example-gateway-3lo-smoke
```

The user receives a Cognito temporary-password email. The login opened by the
smoke target may require setting a permanent password and enrolling a TOTP
authenticator because this example enables MFA by default.

The automated smoke test proves Cognito login, MCP initialization, and that
`github___getAuthenticatedUser` and `github___listUserRepos` appear in
`tools/list`. It deliberately does **not** invoke GitHub because the first tool
call requires interactive GitHub consent.

For the real end-to-end acceptance test:

1. Run `make example-gateway-3lo-config` and copy all four printed
   `MCP_SAVVY_*` values into the standard MCP client configuration shown in the
   [project quickstart](../../README.md#quickstart). Include
   `MCP_SAVVY_COMPLETE_SESSION_URL`.
2. Start the MCP server and invoke `github___getAuthenticatedUser`.
3. Approve the GitHub OAuth page that opens. The bridge should complete the
   AgentCore session and retry the call automatically.
4. Invoke `github___listUserRepos` and confirm it returns repositories visible to
   the signed-in GitHub account.

Only those two successful tool calls prove the full GitHub 3LO chain.

## Tear down

```sh
make example-gateway-3lo-logout
make example-gateway-3lo-destroy
```

The shared GitHub credential provider is **not** destroyed — it was
provisioned out-of-band and may be reused by other gateways. If it is no longer
shared or needed, delete it separately only after confirming the exact name:

```sh
aws bedrock-agentcore-control delete-oauth2-credential-provider \
  --region "$AWS_REGION" --name <provider-name>
```

Deleting the AgentCore provider does not delete the GitHub OAuth App.
