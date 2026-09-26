# gateway-sap-mcp-okta

> This example remains a **service-identity scaffold**. It is not the 2026-09-25
> external AWS for SAP Runtime `USER_FEDERATION` callback proof, and it does not
> exercise `MCP_SAVVY_COMPLETE_SESSION_URL` or named-user SAP authorization.

End-to-end scaffold for this supported access path:

```text
MCP client
  └─ Okta authorization code + PKCE (human user)
      └─ AgentCore Gateway (validates Okta JWT)
          └─ Cognito client credentials (service identity)
              └─ AWS for SAP MCP Server on AgentCore Runtime
                  └─ BASIC or M2M OAuth (SAP technical identity)
                      └─ SAP S/4HANA or ECC OData V2
```

The public endpoint is protected by Okta and AWS for SAP MCP Server is a native
AgentCore Gateway MCP target. Read the exact [API, token, JWT, and MCP
contracts](./CONTRACTS.md) before deployment.

## Important identity boundary

**No Okta-to-Cognito federation is required.** Okta authenticates the human at
the public Gateway. Cognito is a separate client-credentials hop used by the
Gateway to invoke the stock SAP MCP Runtime.

This supported v1 path does **not** preserve the Okta user as the named SAP
user. SAP authorizes and audits the technical identity configured on AWS for
SAP MCP Server. If the acceptance criterion is per-user SAP authorization and
audit records, use the future OBO design below; do not present this scaffold as
end-to-end SSO.

The public AWS for SAP MCP Server v1.0.0 CloudFormation template currently
accepts only `Cognito` and `EntraId` for `InboundAuthProvider`, and its OBO path
is documented around a Microsoft OAuth provider. Generic AgentCore and Okta
support RFC 8693, but the stock SAP deployment does not expose that composition.

## What this example deploys

- One `AgentCoreGateway` with an Okta custom-JWT authorizer.
- One native MCP target pointing at an existing AWS for SAP MCP Runtime.
- Exact-ARN access to an existing AgentCore Identity Cognito OAuth provider and
  its managed secret.
- Gateway support for MCP `2025-06-18` and `2025-11-25`.
- Semantic Gateway search; the client defaults to `passthrough` so the four
  read tools remain visible.

It does not deploy Okta, SAP, the AWS for SAP MCP Runtime, or credentials.

## Prerequisites

You need Node.js 20+, `pnpm`, AWS CLI v2, an AWS profile, an SAP S/4HANA or ECC
OData V2 system, and network connectivity from an AgentCore Runtime VPC to SAP.

Verify the AWS identity before creating resources:

```sh
export AWS_PROFILE=<profile>
export AWS_REGION=us-east-1
aws sts get-caller-identity --profile "$AWS_PROFILE"
pnpm install --frozen-lockfile
```

Never paste Okta, Cognito, or SAP client secrets into chat, shell arguments,
`.env`, or this repository. Put SAP credentials in Secrets Manager and enter
OAuth client secrets through the AWS console or AWS CLI's local interactive
prompt.

## 1. Create the Okta development resources

An Okta Integrator Free Plan is sufficient for the outer Gateway demo. Do not
create the three-authorization-server OBO design unless named-user SAP SSO is
the selected goal.

1. Create/sign in to an [Okta developer org](https://developer.okta.com/signup/).
2. Under **Applications**, create an **OIDC Native Application**.
3. Enable **Authorization Code** and **Refresh Token**. Do not create or use a
   client secret; this is a public PKCE client.
4. Add the sign-in redirect URI `http://localhost:33423/callback`.
5. Assign your test user or test group to the app.
6. Under **Security → API → Authorization Servers**, use the `default` custom
   authorization server or create one. Record its ID and exact audience.
7. Add an access policy/rule permitting the Native app and the requested
   `openid profile email offline_access` scopes.

Return only these non-secret values for deployment:

```text
OKTA_DOMAIN=<tenant>.okta.com
OKTA_CLIENT_ID=<native-app-client-id>
OKTA_AUTH_SERVER_ID=default
OKTA_AUDIENCE=api://default
```

The access token—not the ID token—must have exact `iss`, `aud`, and `cid` values
matching those settings. The smoke flow proves this against the deployed
Gateway.

## 2. Deploy AWS for SAP MCP Server

Use the [vendor CloudFormation deployment](https://docs.aws.amazon.com/mcp-sap/latest/awsforsapmcp/deployment.html)
rather than copying the runtime into this repo. Configure:

- `InboundAuthProvider=Cognito`
- `McpServerReadEnabled=true`
- every write/create/update/delete/function-import flag `false`
- `AuthFlow=BASIC` or `M2M` for SAP technical-principal access
- VPC subnets/security groups that can reach SAP and required AWS endpoints

The stack outputs the encoded Runtime invocation URL, Cognito user pool ID,
client ID, and token endpoint. This example cannot deploy that stack until the
SAP URL, system type/client, network IDs, and outbound auth mode are known.

## 3. Create the Gateway-to-SAP-MCP credential provider

Create one AgentCore Identity OAuth provider in the same account and Region,
then reuse it. It uses the Cognito app client generated by the SAP MCP stack.

To avoid leaking its client secret, use the AgentCore console or the AWS CLI
interactive prompt:

```sh
aws bedrock-agentcore-control create-oauth2-credential-provider \
  --region "$AWS_REGION" --cli-auto-prompt
```

Enter:

- vendor: `CognitoOauth2`
- client ID/secret: the SAP MCP stack's Cognito app client
- authorization endpoint: Cognito domain + `/oauth2/authorize`
- token endpoint: the stack output ending in `/oauth2/token`
- issuer: `https://cognito-idp.<region>.amazonaws.com/<user-pool-id>`

Retrieve only the non-secret references used by CDK:

```sh
aws bedrock-agentcore-control get-oauth2-credential-provider \
  --region "$AWS_REGION" --name <provider-name> \
  --query '{providerArn:credentialProviderArn,secretArn:clientSecretArn.secretArn,status:status}'
```

## 4. Configure the example

Copy `.env.example` to the gitignored `.env`, then set:

```sh
OKTA_DOMAIN=<tenant>.okta.com
OKTA_CLIENT_ID=<native-pkce-client-id>
OKTA_AUTH_SERVER_ID=default
OKTA_AUDIENCE=api://default
OKTA_SCOPES=openid profile email offline_access

SAP_MCP_ENDPOINT=https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/<encoded-arn>/invocations?qualifier=DEFAULT
SAP_MCP_OAUTH_PROVIDER_ARN=arn:aws:acps:us-east-1:<account>:token-vault/<vault>/oauth2credentialprovider/<name>
SAP_MCP_OAUTH_SECRET_ARN=arn:aws:secretsmanager:us-east-1:<account>:secret:bedrock-agentcore-identity!<id>
SAP_MCP_SCOPES=awsforsap-mcp-m2m-resource-server-<unique-id>/read
```

## 5. Deploy the Gateway

```sh
make example-gateway-sap-okta-bootstrap
make example-gateway-sap-okta-synth
make example-gateway-sap-okta-diff
make example-gateway-sap-okta-deploy
make example-gateway-sap-okta-config
```

`deploy` uses `--require-approval=never`; review `diff` first. Target creation
performs MCP capability synchronization and fails if the endpoint, OAuth
provider, secret ARN, or Cognito scope contract is wrong.

## 6. Validate

```sh
make example-gateway-sap-okta-smoke
```

The automated smoke proves Okta login, MCP initialization, and cached discovery
of `find_sap_services`, `get_metadata`, `odata_read`, and `odata_count`. It does
not call SAP.

For real end-to-end acceptance, configure an MCP client with the values from
`make example-gateway-sap-okta-config`, then:

1. Invoke `sap___find_sap_services` with a narrow, safe search.
2. Invoke `sap___get_metadata` for an allowlisted service.
3. Invoke a bounded `sap___odata_count` or `sap___odata_read`.
4. Verify Gateway/Runtime logs and SAP audit records.
5. Confirm SAP attributes the operation to the configured technical identity,
   not the Okta user.

Only successful SAP results prove the full access chain.

## Full Okta named-user SSO: custom/future path

The desired chain is token A (`aud=gateway`) → Gateway RFC 8693 exchange →
token B (`aud=sap-mcp`, same `sub`) → SAP MCP exchange → token C (`aud=sap`,
same `sub`) → SAP OIDC trust and user mapping.

AgentCore Gateway and Okta support those primitives. The stock SAP MCP v1.0.0
template does not. Cognito federation does not repair the missing second
exchange. The honest choices are:

1. use this supported service-identity path;
2. use AWS's documented Entra OBO path for named-user SAP access; or
3. own and security-review a custom SAP MCP Runtime/template for Okta OBO.

For option 3, first confirm SAP S/4HANA/Basis OIDC support and organizational
approval; then create three Okta authorization servers and two confidential
delegate apps. Do not build those resources for an ECC or service-identity
demo.

## Tear down

```sh
make example-gateway-sap-okta-logout
make example-gateway-sap-okta-destroy
```

Destroy removes only this Gateway stack. The shared SAP MCP stack, SAP
resources, Okta app, and AgentCore Identity provider remain deployed.

## Sources

Primary sources and the failure matrix are maintained in [CONTRACTS.md](./CONTRACTS.md).
Checked 2026-09-15. Content was rephrased for compliance with licensing
restrictions.
