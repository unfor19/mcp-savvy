# mcp-savvy Makefile
#
# All repo operations route through this file. Run `make` (or `make help`)
# to see what's available.

.DEFAULT_GOAL := help

.PHONY: help \
        install build typecheck test test-watch test-coverage \
        test-concurrent test-keychain-darwin clean clean-deep \
        check ci fon-check verify python-lock python-lock-check python-test \
        architecture architecture-check \
        example-minimal-bootstrap example-minimal-synth example-minimal-diff \
        example-minimal-deploy example-minimal-destroy \
        example-minimal-config example-minimal-add-user example-minimal-login \
        example-minimal-smoke example-minimal-logout \
        example-oidc-login example-oidc-smoke example-oidc-logout \
        example-minimal-entra-deploy example-minimal-entra-destroy \
        example-minimal-entra-diff \
        example-minimal-entra-config example-minimal-entra-smoke \
        example-minimal-entra-login example-minimal-entra-logout \
        example-gateway-lambda-synth example-gateway-lambda-diff \
        example-gateway-lambda-deploy example-gateway-lambda-destroy \
        example-gateway-lambda-config example-gateway-lambda-add-user \
        example-gateway-lambda-login example-gateway-lambda-smoke \
        example-gateway-lambda-logout \
        example-gateway-lambda-entra-diff example-gateway-lambda-entra-deploy \
        example-gateway-lambda-entra-destroy \
        example-gateway-lambda-entra-login example-gateway-lambda-entra-smoke \
        example-gateway-lambda-entra-logout \
        example-gateway-3lo-synth example-gateway-3lo-diff \
        example-gateway-3lo-deploy example-gateway-3lo-destroy \
        example-gateway-3lo-config example-gateway-3lo-add-user \
        example-gateway-3lo-login example-gateway-3lo-smoke \
        example-gateway-3lo-logout \
        example-kb-synth example-kb-diff \
        example-kb-deploy example-kb-destroy \
        example-kb-config example-kb-add-user \
        example-kb-sync example-kb-ingest \
        example-kb-login example-kb-smoke example-kb-logout \
        example-gateway-kb-synth example-gateway-kb-diff \
        example-gateway-kb-deploy example-gateway-kb-destroy \
        example-gateway-kb-config example-gateway-kb-add-user \
        example-gateway-kb-sync example-gateway-kb-ingest \
        example-gateway-kb-login example-gateway-kb-smoke example-gateway-kb-logout \
        example-chatgpt-app-synth example-chatgpt-app-diff \
        example-chatgpt-app-deploy example-chatgpt-app-destroy \
        example-chatgpt-app-config example-chatgpt-app-add-user \
        example-chatgpt-app-add-callback example-chatgpt-app-seed-customers \
        example-chatgpt-app-animation-install example-chatgpt-app-animation-render \
        example-chatgpt-app-animation-gif example-chatgpt-app-animation-studio \
        example-chatgpt-app-animation-clean \
        publish-placeholder-pack publish-cli-pack publish-cli check-secrets

# =============================================================================
# Tools
# =============================================================================
PNPM ?= pnpm
NODE ?= node
FON ?= fon
UV ?= uv

# AWS profile + region (used once examples/* / cdk land in v0.2+).
# Set AWS_PROFILE in your environment (or via .env) before running any
# example-* target. Falls back to whatever the AWS SDK resolves
# (default profile, env credentials, SSO session, instance role).
AWS_PROFILE ?=
AWS_REGION ?= us-east-1

# Load .env if present (never committed — gitignored by `.*` rule).
ifneq (,$(wildcard .env))
    include .env
    export
endif

# =============================================================================
# Help
# =============================================================================

help: ## Show available targets
	@printf '\n  \033[1mmcp-savvy\033[0m — toolkit for shipping protected MCP servers on AWS\n\n'
	@awk 'BEGIN{FS=":.*##"} /^[a-zA-Z_-]+:.*##/ {printf "  \033[1m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@printf '\n'

# =============================================================================
# Build / typecheck / install
# =============================================================================

install: ## Install workspace dependencies
	$(PNPM) install

build: ## Build every workspace package
	$(PNPM) -r --filter './packages/*' build

typecheck: ## Type-check every package without emitting
	$(PNPM) -r --filter './packages/*' typecheck
	$(PNPM) -r --filter './examples/*/infra' typecheck

# =============================================================================
# Tests
# =============================================================================

test: ## Run the full test suite once (vitest run)
	$(PNPM) test

test-watch: ## Run tests in watch mode (rerun on save)
	$(PNPM) test:watch

test-coverage: clean-coverage ## Run tests with coverage (clean run, fresh report)
	$(PNPM) test:coverage

test-concurrent: build ## Run cross-process lock-coordination tests (Properties 3 + 4 integration)
	$(NODE) scripts/test-concurrent.mjs

test-keychain-darwin: ## Run macOS keychain tests (Darwin-only; no-op on other platforms)
	@if [ "$$(uname -s)" = "Darwin" ]; then \
		$(PNPM) exec vitest run packages/storage/src/keychain; \
	else \
		printf 'Skipping macOS keychain tests on %s\n' "$$(uname -s)"; \
	fi

python-test: ## Run dependency-free Python boundary tests
	cd examples/kb-mcp/agents/agentic && python3 -m unittest test_limits.py

# =============================================================================
# Quality gates
# =============================================================================

fon-check: ## Run the fon code-quality audit
	$(FON) check

check-secrets: ## Scan tracked files for secrets (.env values + generic patterns)
	$(NODE) scripts/check-secrets.mjs

python-lock: ## Resolve and write reproducible Python runtime locks
	cd examples/minimal-mcp/agent && $(UV) lock
	cd examples/kb-mcp/agents/agentic && $(UV) lock

python-lock-check: ## Verify Python runtime locks match their manifests
	cd examples/minimal-mcp/agent && $(UV) lock --check
	cd examples/kb-mcp/agents/agentic && $(UV) lock --check

architecture: ## Regenerate ARCHITECTURE.md from examples/*/example.yaml
	$(NODE) scripts/gen-architecture.mjs

architecture-check: ## Fail if ARCHITECTURE.md is stale (drift guard)
	$(NODE) scripts/gen-architecture.mjs --check

check: typecheck test python-test python-lock-check fon-check architecture-check check-secrets ## Full quality gate: types + tests + locks + fon + docs + secrets

verify: clean-coverage build check ## Pre-commit gate: clean coverage, build, then check

ci: clean-coverage build typecheck test python-test python-lock-check architecture-check check-secrets ## Portable CI gate (fon remains in local verify)

# =============================================================================
# Release (npm)
# =============================================================================

publish-placeholder-pack: ## Stage + pack the v0.0.1 placeholder tarball (no upload)
	$(NODE) scripts/publish-placeholder.mjs

publish-cli-pack: build ## Pack and inspect the real CLI tarball (no upload)
	$(NODE) scripts/release-cli.mjs

publish-cli: ## Verify, pack, inspect, then publish that exact tarball interactively
	$(NODE) scripts/release-cli.mjs --publish

# =============================================================================
# Cleanup
# =============================================================================

clean-coverage: ## Remove the v8 coverage report (regenerated by test-coverage)
	@rm -rf coverage

clean: clean-coverage ## Remove build artifacts (dist/, coverage/)
	@find packages -type d -name dist -prune -exec rm -rf {} +
	@rm -rf .fon/workdir

clean-deep: clean ## clean + remove node_modules everywhere
	@rm -rf node_modules
	@find packages -type d -name node_modules -prune -exec rm -rf {} +

# =============================================================================
# Examples
# =============================================================================
EXAMPLE_MINIMAL_DIR := examples/minimal-mcp
EXAMPLE_MINIMAL_INFRA := $(EXAMPLE_MINIMAL_DIR)/infra
CDK := $(PNPM) --filter @mcp-savvy-examples/minimal-mcp-infra exec cdk
CFN := AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) aws cloudformation
COGNITO := AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) aws cognito-idp

example-minimal-bootstrap: ## CDK bootstrap target account/region (run once)
	$(CDK) bootstrap aws://$$(aws sts get-caller-identity --profile $(AWS_PROFILE) --query Account --output text)/$(AWS_REGION)

example-minimal-synth: ## Synthesize CloudFormation for the minimal-mcp example
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(CDK) synth --strict

example-minimal-diff: ## Show pending changes vs deployed minimal-mcp stacks
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(CDK) diff

example-minimal-deploy: example-minimal-diff ## Deploy minimal-mcp (Cognito + AgentCore Runtime)
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(CDK) deploy --all --require-approval=never

example-minimal-destroy: ## Destroy the minimal-mcp stacks
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(CDK) destroy --all --force

example-minimal-config: ## Print mcp-savvy client config from deployed outputs
	@USER_POOL=$$($(CFN) describe-stacks --stack-name McpSavvyDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text); \
	ISSUER=$$($(CFN) describe-stacks --stack-name McpSavvyDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`IssuerUrl`].OutputValue' --output text); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvyDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text); \
	ARN=$$($(CFN) describe-stacks --stack-name McpSavvyDemoRuntime \
		--query 'Stacks[0].Outputs[?OutputKey==`RuntimeArn`].OutputValue' --output text); \
	REGION=$$($(CFN) describe-stacks --stack-name McpSavvyDemoRuntime \
		--query 'Stacks[0].Outputs[?OutputKey==`RuntimeRegion`].OutputValue' --output text); \
	if [ -z "$$ARN" ] || [ -z "$$ISSUER" ]; then \
		printf 'Stacks not deployed yet. Run: make example-minimal-deploy\n'; \
		exit 1; \
	fi; \
	ENC=$$(printf '%s' "$$ARN" | sed 's/:/%3A/g; s|/|%2F|g'); \
	URL="https://bedrock-agentcore.$$REGION.amazonaws.com/runtimes/$$ENC/invocations?qualifier=DEFAULT"; \
	printf '\n  \033[1mmcp-savvy minimal-mcp client config\033[0m\n\n'; \
	printf '  MCP_SAVVY_REMOTE_URL=%s\n' "$$URL"; \
	printf '  MCP_SAVVY_OIDC_ISSUER=%s\n' "$$ISSUER"; \
	printf '  MCP_SAVVY_CLIENT_ID=%s\n\n' "$$CLIENT"

example-minimal-add-user: ## Provision a Cognito user (EMAIL=name@example.com)
	@if [ -z "$(EMAIL)" ]; then printf 'Usage: make example-minimal-add-user EMAIL=name@example.com\n'; exit 1; fi
	@USER_POOL=$$($(CFN) describe-stacks --stack-name McpSavvyDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text); \
	$(COGNITO) admin-create-user --user-pool-id "$$USER_POOL" --username "$(EMAIL)" \
		--user-attributes Name=email,Value=$(EMAIL) Name=email_verified,Value=true \
		--desired-delivery-mediums EMAIL

example-minimal-login: build ## Run mcp-savvy --login against the deployed minimal-mcp stack
	@ISSUER=$$($(CFN) describe-stacks --stack-name McpSavvyDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`IssuerUrl`].OutputValue' --output text); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvyDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text); \
	ARN=$$($(CFN) describe-stacks --stack-name McpSavvyDemoRuntime \
		--query 'Stacks[0].Outputs[?OutputKey==`RuntimeArn`].OutputValue' --output text); \
	REGION=$$($(CFN) describe-stacks --stack-name McpSavvyDemoRuntime \
		--query 'Stacks[0].Outputs[?OutputKey==`RuntimeRegion`].OutputValue' --output text); \
	if [ -z "$$ARN" ] || [ -z "$$ISSUER" ]; then \
		printf 'Stacks not deployed yet. Run: make example-minimal-deploy\n'; \
		exit 1; \
	fi; \
	ENC=$$(printf '%s' "$$ARN" | sed 's/:/%3A/g; s|/|%2F|g'); \
	URL="https://bedrock-agentcore.$$REGION.amazonaws.com/runtimes/$$ENC/invocations?qualifier=DEFAULT"; \
	env -u MCP_SAVVY_CALLBACK_HOST -u MCP_SAVVY_CALLBACK_PORT -u MCP_SAVVY_CALLBACK_PATH -u MCP_SAVVY_PROVIDER -u MCP_SAVVY_SCOPES \
	MCP_SAVVY_REMOTE_URL="$$URL" \
	MCP_SAVVY_OIDC_ISSUER="$$ISSUER" \
	MCP_SAVVY_CLIENT_ID="$$CLIENT" \
		node packages/cli/dist/cli.js --login

example-minimal-smoke: build example-minimal-login ## End-to-end smoke test: list tools + invoke echo via the bridge
	@ISSUER=$$($(CFN) describe-stacks --stack-name McpSavvyDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`IssuerUrl`].OutputValue' --output text); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvyDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text); \
	ARN=$$($(CFN) describe-stacks --stack-name McpSavvyDemoRuntime \
		--query 'Stacks[0].Outputs[?OutputKey==`RuntimeArn`].OutputValue' --output text); \
	REGION=$$($(CFN) describe-stacks --stack-name McpSavvyDemoRuntime \
		--query 'Stacks[0].Outputs[?OutputKey==`RuntimeRegion`].OutputValue' --output text); \
	if [ -z "$$ARN" ] || [ -z "$$ISSUER" ]; then \
		printf 'Stacks not deployed yet. Run: make example-minimal-deploy\n'; \
		exit 1; \
	fi; \
	ENC=$$(printf '%s' "$$ARN" | sed 's/:/%3A/g; s|/|%2F|g'); \
	URL="https://bedrock-agentcore.$$REGION.amazonaws.com/runtimes/$$ENC/invocations?qualifier=DEFAULT"; \
	env -u MCP_SAVVY_CALLBACK_HOST -u MCP_SAVVY_CALLBACK_PORT -u MCP_SAVVY_CALLBACK_PATH -u MCP_SAVVY_PROVIDER -u MCP_SAVVY_SCOPES \
	MCP_SAVVY_REMOTE_URL="$$URL" \
	MCP_SAVVY_OIDC_ISSUER="$$ISSUER" \
	MCP_SAVVY_CLIENT_ID="$$CLIENT" \
		node scripts/smoke/minimal.mjs

# -----------------------------------------------------------------------------
# Generic OIDC targets — point mcp-savvy at any IdP via .env (Entra, Okta, …)
# Required env vars (any combination of .env or shell exports):
#   MCP_SAVVY_REMOTE_URL, MCP_SAVVY_OIDC_ISSUER, MCP_SAVVY_CLIENT_ID
# Optional:
#   MCP_SAVVY_PROVIDER (defaults to 'oidc'), MCP_SAVVY_SCOPES, MCP_SAVVY_*
# Copy `.env.example` to `.env` and fill in the values for your IdP.
# -----------------------------------------------------------------------------

example-oidc-login: build ## Run mcp-savvy --login using MCP_SAVVY_* from env / .env
	@if [ -z "$(MCP_SAVVY_REMOTE_URL)" ] || [ -z "$(MCP_SAVVY_OIDC_ISSUER)" ] || [ -z "$(MCP_SAVVY_CLIENT_ID)" ]; then \
		printf 'Missing env vars. Copy .env.example to .env and fill in:\n'; \
		printf '  MCP_SAVVY_REMOTE_URL\n  MCP_SAVVY_OIDC_ISSUER\n  MCP_SAVVY_CLIENT_ID\n'; \
		exit 1; \
	fi
	@MCP_SAVVY_PROVIDER="$${MCP_SAVVY_PROVIDER:-oidc}" \
		node packages/cli/dist/cli.js --login

example-oidc-smoke: build ## End-to-end smoke test using MCP_SAVVY_* from env / .env
	@if [ -z "$(MCP_SAVVY_REMOTE_URL)" ] || [ -z "$(MCP_SAVVY_OIDC_ISSUER)" ] || [ -z "$(MCP_SAVVY_CLIENT_ID)" ]; then \
		printf 'Missing env vars. Copy .env.example to .env and fill in:\n'; \
		printf '  MCP_SAVVY_REMOTE_URL\n  MCP_SAVVY_OIDC_ISSUER\n  MCP_SAVVY_CLIENT_ID\n'; \
		exit 1; \
	fi
	@MCP_SAVVY_PROVIDER="$${MCP_SAVVY_PROVIDER:-oidc}" \
		node scripts/smoke/minimal.mjs

# -----------------------------------------------------------------------------
# Entra ID parallel deploy of minimal-mcp.
# Same agent, same RuntimeStack, but the runtime is gated by JWT from
# your Entra tenant instead of Cognito. Drives the external-OIDC variant.
# §14: proof that the v0.1 client + L2 Runtime construct are IdP-agnostic.
#
# Required env vars in .env (or shell):
#   ENTRA_TENANT_ID, ENTRA_CLIENT_ID
# Optional:
#   ENTRA_AUDIENCE (defaults to api://$(ENTRA_CLIENT_ID))
# -----------------------------------------------------------------------------
ENTRA_CDK := MCP_SAVVY_DEMO_IDP=entra \
	ENTRA_TENANT_ID=$(ENTRA_TENANT_ID) \
	ENTRA_CLIENT_ID=$(ENTRA_CLIENT_ID) \
	$(if $(ENTRA_AUDIENCE),ENTRA_AUDIENCE=$(ENTRA_AUDIENCE),) \
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(CDK)

example-minimal-entra-deploy: ## Deploy the Entra-gated parallel runtime (McpSavvyDemoEntraRuntime)
	@if [ -z "$(ENTRA_TENANT_ID)" ] || [ -z "$(ENTRA_CLIENT_ID)" ]; then \
		printf 'Missing ENTRA_TENANT_ID or ENTRA_CLIENT_ID. Copy .env.example to .env and fill in.\n'; exit 1; \
	fi
	$(ENTRA_CDK) diff McpSavvyDemoEntraRuntime
	$(ENTRA_CDK) deploy McpSavvyDemoEntraRuntime --require-approval=never

example-minimal-entra-diff: ## Show pending changes vs the deployed Entra-gated runtime
	@if [ -z "$(ENTRA_TENANT_ID)" ] || [ -z "$(ENTRA_CLIENT_ID)" ]; then \
		printf 'Missing ENTRA_TENANT_ID or ENTRA_CLIENT_ID. Copy .env.example to .env and fill in.\n'; exit 1; \
	fi
	$(ENTRA_CDK) diff McpSavvyDemoEntraRuntime

example-minimal-entra-destroy: ## Destroy the Entra-gated parallel runtime
	@if [ -z "$(ENTRA_TENANT_ID)" ] || [ -z "$(ENTRA_CLIENT_ID)" ]; then \
		printf 'Missing ENTRA_TENANT_ID or ENTRA_CLIENT_ID. Copy .env.example to .env and fill in.\n'; exit 1; \
	fi
	$(ENTRA_CDK) destroy McpSavvyDemoEntraRuntime --force

example-minimal-entra-config: ## Print mcp-savvy client config for the Entra-gated runtime
	@ARN=$$($(CFN) describe-stacks --stack-name McpSavvyDemoEntraRuntime \
		--query 'Stacks[0].Outputs[?OutputKey==`RuntimeArn`].OutputValue' --output text 2>/dev/null); \
	REGION=$$($(CFN) describe-stacks --stack-name McpSavvyDemoEntraRuntime \
		--query 'Stacks[0].Outputs[?OutputKey==`RuntimeRegion`].OutputValue' --output text 2>/dev/null); \
	if [ -z "$$ARN" ]; then \
		printf 'Stack not deployed yet. Run: make example-minimal-entra-deploy\n'; exit 1; \
	fi; \
	if [ -z "$(ENTRA_TENANT_ID)" ] || [ -z "$(ENTRA_CLIENT_ID)" ]; then \
		printf 'Missing ENTRA_TENANT_ID / ENTRA_CLIENT_ID — fill them in .env.\n'; exit 1; \
	fi; \
	ENC=$$(printf '%s' "$$ARN" | sed 's/:/%3A/g; s|/|%2F|g'); \
	URL="https://bedrock-agentcore.$$REGION.amazonaws.com/runtimes/$$ENC/invocations?qualifier=DEFAULT"; \
	printf '\n  \033[1mmcp-savvy minimal-mcp (Entra) client config\033[0m\n\n'; \
	printf '  MCP_SAVVY_PROVIDER=oidc\n'; \
	printf '  MCP_SAVVY_REMOTE_URL=%s\n' "$$URL"; \
	printf '  MCP_SAVVY_OIDC_ISSUER=https://login.microsoftonline.com/%s/v2.0\n' "$(ENTRA_TENANT_ID)"; \
	printf '  MCP_SAVVY_CLIENT_ID=%s\n' "$(ENTRA_CLIENT_ID)"; \
	printf '  MCP_SAVVY_CALLBACK_PORT=3456\n'; \
	printf '  MCP_SAVVY_SCOPES="openid email profile %s/.default"\n\n' "$(ENTRA_CLIENT_ID)"

example-minimal-entra-smoke: build example-minimal-entra-login ## End-to-end smoke test against the Entra-gated runtime
	@ARN=$$($(CFN) describe-stacks --stack-name McpSavvyDemoEntraRuntime \
		--query 'Stacks[0].Outputs[?OutputKey==`RuntimeArn`].OutputValue' --output text 2>/dev/null); \
	REGION=$$($(CFN) describe-stacks --stack-name McpSavvyDemoEntraRuntime \
		--query 'Stacks[0].Outputs[?OutputKey==`RuntimeRegion`].OutputValue' --output text 2>/dev/null); \
	if [ -z "$$ARN" ]; then \
		printf 'Stack not deployed yet. Run: make example-minimal-entra-deploy\n'; exit 1; \
	fi; \
	if [ -z "$(ENTRA_TENANT_ID)" ] || [ -z "$(ENTRA_CLIENT_ID)" ]; then \
		printf 'Missing ENTRA_TENANT_ID / ENTRA_CLIENT_ID in .env\n'; exit 1; \
	fi; \
	ENC=$$(printf '%s' "$$ARN" | sed 's/:/%3A/g; s|/|%2F|g'); \
	URL="https://bedrock-agentcore.$$REGION.amazonaws.com/runtimes/$$ENC/invocations?qualifier=DEFAULT"; \
	MCP_SAVVY_PROVIDER=oidc \
	MCP_SAVVY_REMOTE_URL="$$URL" \
	MCP_SAVVY_OIDC_ISSUER="https://login.microsoftonline.com/$(ENTRA_TENANT_ID)/v2.0" \
	MCP_SAVVY_CLIENT_ID="$(ENTRA_CLIENT_ID)" \
	MCP_SAVVY_CALLBACK_HOST="$${MCP_SAVVY_CALLBACK_HOST:-localhost}" \
	MCP_SAVVY_CALLBACK_PORT="$${MCP_SAVVY_CALLBACK_PORT:-3456}" \
	MCP_SAVVY_SCOPES="openid email profile $(ENTRA_CLIENT_ID)/.default" \
		node scripts/smoke/minimal.mjs

example-minimal-entra-login: build ## Sign in to Entra (caches a fresh token, useful after manifest edits)
	@if [ -z "$(ENTRA_TENANT_ID)" ] || [ -z "$(ENTRA_CLIENT_ID)" ]; then \
		printf 'Missing ENTRA_TENANT_ID / ENTRA_CLIENT_ID in .env\n'; exit 1; \
	fi
	@ARN=$$($(CFN) describe-stacks --stack-name McpSavvyDemoEntraRuntime \
		--query 'Stacks[0].Outputs[?OutputKey==`RuntimeArn`].OutputValue' --output text 2>/dev/null); \
	REGION=$$($(CFN) describe-stacks --stack-name McpSavvyDemoEntraRuntime \
		--query 'Stacks[0].Outputs[?OutputKey==`RuntimeRegion`].OutputValue' --output text 2>/dev/null); \
	if [ -z "$$ARN" ]; then \
		printf 'Stack not deployed yet. Run: make example-minimal-entra-deploy\n'; exit 1; \
	fi; \
	ENC=$$(printf '%s' "$$ARN" | sed 's/:/%3A/g; s|/|%2F|g'); \
	URL="https://bedrock-agentcore.$$REGION.amazonaws.com/runtimes/$$ENC/invocations?qualifier=DEFAULT"; \
	MCP_SAVVY_PROVIDER=oidc \
	MCP_SAVVY_REMOTE_URL="$$URL" \
	MCP_SAVVY_OIDC_ISSUER="https://login.microsoftonline.com/$(ENTRA_TENANT_ID)/v2.0" \
	MCP_SAVVY_CLIENT_ID="$(ENTRA_CLIENT_ID)" \
	MCP_SAVVY_CALLBACK_HOST="$${MCP_SAVVY_CALLBACK_HOST:-localhost}" \
	MCP_SAVVY_CALLBACK_PORT="$${MCP_SAVVY_CALLBACK_PORT:-3456}" \
	MCP_SAVVY_SCOPES="openid email profile $(ENTRA_CLIENT_ID)/.default" \
		node packages/cli/dist/cli.js --login

example-minimal-entra-logout: build ## Clear cached Entra tokens (forces a fresh sign-in next run)
	@if [ -z "$(ENTRA_TENANT_ID)" ] || [ -z "$(ENTRA_CLIENT_ID)" ]; then \
		printf 'Missing ENTRA_TENANT_ID / ENTRA_CLIENT_ID in .env\n'; exit 1; \
	fi
	@MCP_SAVVY_PROVIDER=oidc \
	MCP_SAVVY_REMOTE_URL=https://placeholder.example.com \
	MCP_SAVVY_OIDC_ISSUER="https://login.microsoftonline.com/$(ENTRA_TENANT_ID)/v2.0" \
	MCP_SAVVY_CLIENT_ID="$(ENTRA_CLIENT_ID)" \
		node packages/cli/dist/cli.js --logout

example-minimal-logout: build ## Clear cached Cognito tokens for the deployed minimal-mcp stack
	@ISSUER=$$($(CFN) describe-stacks --stack-name McpSavvyDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`IssuerUrl`].OutputValue' --output text 2>/dev/null); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvyDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text 2>/dev/null); \
	if [ -z "$$ISSUER" ]; then \
		printf 'Stack not deployed yet. Run: make example-minimal-deploy\n'; exit 1; \
	fi; \
	MCP_SAVVY_REMOTE_URL=https://placeholder.example.com \
	MCP_SAVVY_OIDC_ISSUER="$$ISSUER" \
	MCP_SAVVY_CLIENT_ID="$$CLIENT" \
		node packages/cli/dist/cli.js --logout

example-oidc-logout: build ## Clear cached tokens for the IdP in MCP_SAVVY_* / .env
	@if [ -z "$(MCP_SAVVY_OIDC_ISSUER)" ] || [ -z "$(MCP_SAVVY_CLIENT_ID)" ]; then \
		printf 'Missing MCP_SAVVY_OIDC_ISSUER / MCP_SAVVY_CLIENT_ID in env / .env\n'; exit 1; \
	fi
	@MCP_SAVVY_PROVIDER="$${MCP_SAVVY_PROVIDER:-oidc}" \
	MCP_SAVVY_REMOTE_URL="$${MCP_SAVVY_REMOTE_URL:-https://placeholder.example.com}" \
		node packages/cli/dist/cli.js --logout



# =============================================================================
# Examples — gateway-lambda-mcp (Cognito + AgentCore Gateway + Lambda tools)
# =============================================================================
EXAMPLE_GW_LAMBDA_DIR := examples/gateway-lambda-mcp
EXAMPLE_GW_LAMBDA_INFRA := $(EXAMPLE_GW_LAMBDA_DIR)/infra
GW_LAMBDA_CDK := $(PNPM) --filter @mcp-savvy-examples/gateway-lambda-mcp-infra exec cdk

example-gateway-lambda-synth: ## Synthesize CloudFormation for the gateway-lambda-mcp example
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(GW_LAMBDA_CDK) synth --strict

example-gateway-lambda-diff: ## Show pending changes vs deployed gateway-lambda-mcp stacks
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(GW_LAMBDA_CDK) diff

example-gateway-lambda-deploy: example-gateway-lambda-diff ## Deploy gateway-lambda-mcp (Cognito + AgentCore Gateway + Lambda)
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(GW_LAMBDA_CDK) deploy --all --require-approval=never

example-gateway-lambda-destroy: ## Destroy the gateway-lambda-mcp stacks
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(GW_LAMBDA_CDK) destroy --all --force

example-gateway-lambda-config: ## Print mcp-savvy client config from deployed gateway-lambda outputs
	@ISSUER=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`IssuerUrl`].OutputValue' --output text); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text); \
	URL=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayDemoGateway \
		--query 'Stacks[0].Outputs[?OutputKey==`GatewayUrl`].OutputValue' --output text); \
	if [ -z "$$URL" ] || [ -z "$$ISSUER" ]; then \
		printf 'Stacks not deployed yet. Run: make example-gateway-lambda-deploy\n'; \
		exit 1; \
	fi; \
	printf '\n  \033[1mmcp-savvy gateway-lambda-mcp client config\033[0m\n\n'; \
	printf '  MCP_SAVVY_REMOTE_URL=%s\n' "$$URL"; \
	printf '  MCP_SAVVY_OIDC_ISSUER=%s\n' "$$ISSUER"; \
	printf '  MCP_SAVVY_CLIENT_ID=%s\n\n' "$$CLIENT"

example-gateway-lambda-add-user: ## Provision a Cognito user for gateway-lambda-mcp (EMAIL=name@example.com)
	@if [ -z "$(EMAIL)" ]; then printf 'Usage: make example-gateway-lambda-add-user EMAIL=name@example.com\n'; exit 1; fi
	@USER_POOL=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text); \
	$(COGNITO) admin-create-user --user-pool-id "$$USER_POOL" --username "$(EMAIL)" \
		--user-attributes Name=email,Value=$(EMAIL) Name=email_verified,Value=true \
		--desired-delivery-mediums EMAIL

example-gateway-lambda-login: build ## Run mcp-savvy --login against the deployed gateway-lambda-mcp stack
	@ISSUER=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`IssuerUrl`].OutputValue' --output text); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text); \
	URL=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayDemoGateway \
		--query 'Stacks[0].Outputs[?OutputKey==`GatewayUrl`].OutputValue' --output text); \
	if [ -z "$$URL" ] || [ -z "$$ISSUER" ]; then \
		printf 'Stacks not deployed yet. Run: make example-gateway-lambda-deploy\n'; \
		exit 1; \
	fi; \
	env -u MCP_SAVVY_CALLBACK_HOST -u MCP_SAVVY_CALLBACK_PORT -u MCP_SAVVY_CALLBACK_PATH -u MCP_SAVVY_PROVIDER -u MCP_SAVVY_SCOPES \
	MCP_SAVVY_REMOTE_URL="$$URL" \
	MCP_SAVVY_OIDC_ISSUER="$$ISSUER" \
	MCP_SAVVY_CLIENT_ID="$$CLIENT" \
		node packages/cli/dist/cli.js --login

example-gateway-lambda-smoke: build example-gateway-lambda-login ## End-to-end smoke test: list tools + invoke each Lambda tool via the bridge
	@ISSUER=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`IssuerUrl`].OutputValue' --output text); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text); \
	URL=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayDemoGateway \
		--query 'Stacks[0].Outputs[?OutputKey==`GatewayUrl`].OutputValue' --output text); \
	if [ -z "$$URL" ] || [ -z "$$ISSUER" ]; then \
		printf 'Stacks not deployed yet. Run: make example-gateway-lambda-deploy\n'; \
		exit 1; \
	fi; \
	env -u MCP_SAVVY_CALLBACK_HOST -u MCP_SAVVY_CALLBACK_PORT -u MCP_SAVVY_CALLBACK_PATH -u MCP_SAVVY_PROVIDER -u MCP_SAVVY_SCOPES \
	MCP_SAVVY_REMOTE_URL="$$URL" \
	MCP_SAVVY_OIDC_ISSUER="$$ISSUER" \
	MCP_SAVVY_CLIENT_ID="$$CLIENT" \
		node scripts/smoke/gateway/lambda.mjs

example-gateway-lambda-logout: build ## Clear cached tokens for the deployed gateway-lambda-mcp stack
	@ISSUER=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`IssuerUrl`].OutputValue' --output text 2>/dev/null); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text 2>/dev/null); \
	if [ -z "$$ISSUER" ]; then \
		printf 'Stack not deployed yet. Run: make example-gateway-lambda-deploy\n'; exit 1; \
	fi; \
	MCP_SAVVY_REMOTE_URL=https://placeholder.example.com \
	MCP_SAVVY_OIDC_ISSUER="$$ISSUER" \
	MCP_SAVVY_CLIENT_ID="$$CLIENT" \
		node packages/cli/dist/cli.js --logout

# -----------------------------------------------------------------------------
# Entra-gated parallel deploy of gateway-lambda-mcp.
# Uses the same agent + IaC, but swaps the IdP via MCP_SAVVY_DEMO_IDP=entra.
# Required vars from .env: ENTRA_TENANT_ID, ENTRA_CLIENT_ID
# Optional: ENTRA_AUDIENCE (defaults to ENTRA_CLIENT_ID)
# -----------------------------------------------------------------------------
GW_LAMBDA_ENTRA_CDK := MCP_SAVVY_DEMO_IDP=entra \
	ENTRA_TENANT_ID=$(ENTRA_TENANT_ID) \
	ENTRA_CLIENT_ID=$(ENTRA_CLIENT_ID) \
	$(if $(ENTRA_AUDIENCE),ENTRA_AUDIENCE=$(ENTRA_AUDIENCE),) \
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(GW_LAMBDA_CDK)

example-gateway-lambda-entra-diff: ## Show pending changes vs the deployed Entra-gated gateway
	@if [ -z "$(ENTRA_TENANT_ID)" ] || [ -z "$(ENTRA_CLIENT_ID)" ]; then \
		printf 'Missing ENTRA_TENANT_ID or ENTRA_CLIENT_ID. Copy .env.example to .env and fill in.\n'; exit 1; \
	fi
	$(GW_LAMBDA_ENTRA_CDK) diff McpSavvyGatewayDemoEntraGateway

example-gateway-lambda-entra-deploy: ## Deploy the Entra-gated parallel gateway (McpSavvyGatewayDemoEntraGateway)
	@if [ -z "$(ENTRA_TENANT_ID)" ] || [ -z "$(ENTRA_CLIENT_ID)" ]; then \
		printf 'Missing ENTRA_TENANT_ID or ENTRA_CLIENT_ID. Copy .env.example to .env and fill in.\n'; exit 1; \
	fi
	$(GW_LAMBDA_ENTRA_CDK) diff McpSavvyGatewayDemoEntraGateway
	$(GW_LAMBDA_ENTRA_CDK) deploy McpSavvyGatewayDemoEntraGateway --require-approval=never

example-gateway-lambda-entra-destroy: ## Destroy the Entra-gated parallel gateway
	@if [ -z "$(ENTRA_TENANT_ID)" ] || [ -z "$(ENTRA_CLIENT_ID)" ]; then \
		printf 'Missing ENTRA_TENANT_ID or ENTRA_CLIENT_ID. Copy .env.example to .env and fill in.\n'; exit 1; \
	fi
	$(GW_LAMBDA_ENTRA_CDK) destroy McpSavvyGatewayDemoEntraGateway --force

example-gateway-lambda-entra-login: build ## Sign in to Entra (caches a fresh token, gateway-lambda flavor)
	@if [ -z "$(ENTRA_TENANT_ID)" ] || [ -z "$(ENTRA_CLIENT_ID)" ]; then \
		printf 'Missing ENTRA_TENANT_ID / ENTRA_CLIENT_ID in .env\n'; exit 1; \
	fi
	@URL=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayDemoEntraGateway \
		--query 'Stacks[0].Outputs[?OutputKey==`GatewayUrl`].OutputValue' --output text 2>/dev/null); \
	if [ -z "$$URL" ]; then \
		printf 'Stack not deployed yet. Run: make example-gateway-lambda-entra-deploy\n'; exit 1; \
	fi; \
	MCP_SAVVY_PROVIDER=oidc \
	MCP_SAVVY_REMOTE_URL="$$URL" \
	MCP_SAVVY_OIDC_ISSUER="https://login.microsoftonline.com/$(ENTRA_TENANT_ID)/v2.0" \
	MCP_SAVVY_CLIENT_ID="$(ENTRA_CLIENT_ID)" \
	MCP_SAVVY_CALLBACK_HOST="$${MCP_SAVVY_CALLBACK_HOST:-localhost}" \
	MCP_SAVVY_CALLBACK_PORT="$${MCP_SAVVY_CALLBACK_PORT:-3456}" \
	MCP_SAVVY_SCOPES="openid email profile $(ENTRA_CLIENT_ID)/.default" \
		node packages/cli/dist/cli.js --login

example-gateway-lambda-entra-smoke: build example-gateway-lambda-entra-login ## End-to-end smoke against the Entra-gated gateway
	@URL=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayDemoEntraGateway \
		--query 'Stacks[0].Outputs[?OutputKey==`GatewayUrl`].OutputValue' --output text 2>/dev/null); \
	if [ -z "$$URL" ]; then \
		printf 'Stack not deployed yet. Run: make example-gateway-lambda-entra-deploy\n'; exit 1; \
	fi; \
	if [ -z "$(ENTRA_TENANT_ID)" ] || [ -z "$(ENTRA_CLIENT_ID)" ]; then \
		printf 'Missing ENTRA_TENANT_ID / ENTRA_CLIENT_ID in .env\n'; exit 1; \
	fi; \
	MCP_SAVVY_PROVIDER=oidc \
	MCP_SAVVY_REMOTE_URL="$$URL" \
	MCP_SAVVY_OIDC_ISSUER="https://login.microsoftonline.com/$(ENTRA_TENANT_ID)/v2.0" \
	MCP_SAVVY_CLIENT_ID="$(ENTRA_CLIENT_ID)" \
	MCP_SAVVY_CALLBACK_HOST="$${MCP_SAVVY_CALLBACK_HOST:-localhost}" \
	MCP_SAVVY_CALLBACK_PORT="$${MCP_SAVVY_CALLBACK_PORT:-3456}" \
	MCP_SAVVY_SCOPES="openid email profile $(ENTRA_CLIENT_ID)/.default" \
		node scripts/smoke/gateway/lambda.mjs

example-gateway-lambda-entra-logout: build ## Clear cached Entra tokens for the gateway-lambda flavor
	@if [ -z "$(ENTRA_TENANT_ID)" ] || [ -z "$(ENTRA_CLIENT_ID)" ]; then \
		printf 'Missing ENTRA_TENANT_ID / ENTRA_CLIENT_ID in .env\n'; exit 1; \
	fi
	@MCP_SAVVY_PROVIDER=oidc \
	MCP_SAVVY_REMOTE_URL=https://placeholder.example.com \
	MCP_SAVVY_OIDC_ISSUER="https://login.microsoftonline.com/$(ENTRA_TENANT_ID)/v2.0" \
	MCP_SAVVY_CLIENT_ID="$(ENTRA_CLIENT_ID)" \
		node packages/cli/dist/cli.js --logout


# -----------------------------------------------------------------------------
# gateway-3lo-mcp (Cognito + AgentCore Gateway with GitHub OAuth2 target +
# OAuthCompleteSessionApi). Requires MCP_SAVVY_GITHUB_OAUTH_PROVIDER_ARN to
# be set (configure once via the AWS console / CLI; reuse across gateways).
# -----------------------------------------------------------------------------
GW_3LO_CDK := $(PNPM) --filter @mcp-savvy-examples/gateway-3lo-mcp-infra exec cdk

example-gateway-3lo-synth: ## Synthesize CloudFormation for the gateway-3lo-mcp example
	@if [ -z "$(MCP_SAVVY_GITHUB_OAUTH_PROVIDER_ARN)" ]; then \
		printf 'Missing MCP_SAVVY_GITHUB_OAUTH_PROVIDER_ARN. See examples/gateway-3lo-mcp/README.md.\n'; exit 1; \
	fi
	MCP_SAVVY_GITHUB_OAUTH_PROVIDER_ARN=$(MCP_SAVVY_GITHUB_OAUTH_PROVIDER_ARN) \
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(GW_3LO_CDK) synth --strict

example-gateway-3lo-diff: ## Show pending changes vs deployed gateway-3lo-mcp stacks
	@if [ -z "$(MCP_SAVVY_GITHUB_OAUTH_PROVIDER_ARN)" ]; then \
		printf 'Missing MCP_SAVVY_GITHUB_OAUTH_PROVIDER_ARN. See examples/gateway-3lo-mcp/README.md.\n'; exit 1; \
	fi
	MCP_SAVVY_GITHUB_OAUTH_PROVIDER_ARN=$(MCP_SAVVY_GITHUB_OAUTH_PROVIDER_ARN) \
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(GW_3LO_CDK) diff

example-gateway-3lo-deploy: example-gateway-3lo-diff ## Deploy gateway-3lo-mcp (Cognito + Gateway + GitHub OpenAPI target + OAuthCompleteSessionApi)
	MCP_SAVVY_GITHUB_OAUTH_PROVIDER_ARN=$(MCP_SAVVY_GITHUB_OAUTH_PROVIDER_ARN) \
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(GW_3LO_CDK) deploy --all --require-approval=never

example-gateway-3lo-destroy: ## Destroy the gateway-3lo-mcp stacks (does not destroy the shared GitHub credential provider)
	MCP_SAVVY_GITHUB_OAUTH_PROVIDER_ARN=$(MCP_SAVVY_GITHUB_OAUTH_PROVIDER_ARN) \
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(GW_3LO_CDK) destroy --all --force

example-gateway-3lo-config: ## Print mcp-savvy client config from deployed gateway-3lo outputs
	@ISSUER=$$($(CFN) describe-stacks --stack-name McpSavvy3loDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`IssuerUrl`].OutputValue' --output text); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvy3loDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text); \
	URL=$$($(CFN) describe-stacks --stack-name McpSavvy3loDemoGateway \
		--query 'Stacks[0].Outputs[?OutputKey==`GatewayUrl`].OutputValue' --output text); \
	COMPLETE=$$($(CFN) describe-stacks --stack-name McpSavvy3loDemoGateway \
		--query 'Stacks[0].Outputs[?OutputKey==`CompleteSessionUrl`].OutputValue' --output text); \
	if [ -z "$$URL" ] || [ -z "$$ISSUER" ]; then \
		printf 'Stacks not deployed yet. Run: make example-gateway-3lo-deploy\n'; \
		exit 1; \
	fi; \
	printf 'mcp-savvy client config (gateway-3lo-mcp):\n\n'; \
	printf '  MCP_SAVVY_REMOTE_URL=%s\n' "$$URL"; \
	printf '  MCP_SAVVY_OIDC_ISSUER=%s\n' "$$ISSUER"; \
	printf '  MCP_SAVVY_CLIENT_ID=%s\n' "$$CLIENT"; \
	printf '  MCP_SAVVY_COMPLETE_SESSION_URL=%s\n\n' "$$COMPLETE"

example-gateway-3lo-add-user: ## Provision a Cognito user for gateway-3lo-mcp (EMAIL=name@example.com)
	@if [ -z "$(EMAIL)" ]; then printf 'Usage: make example-gateway-3lo-add-user EMAIL=name@example.com\n'; exit 1; fi
	@USER_POOL=$$($(CFN) describe-stacks --stack-name McpSavvy3loDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text); \
	$(COGNITO) admin-create-user --user-pool-id "$$USER_POOL" --username "$(EMAIL)" \
		--user-attributes Name=email,Value="$(EMAIL)" Name=email_verified,Value=true \
		--desired-delivery-mediums EMAIL

example-gateway-3lo-login: build ## Run mcp-savvy --login against the deployed gateway-3lo-mcp stack
	@ISSUER=$$($(CFN) describe-stacks --stack-name McpSavvy3loDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`IssuerUrl`].OutputValue' --output text); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvy3loDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text); \
	URL=$$($(CFN) describe-stacks --stack-name McpSavvy3loDemoGateway \
		--query 'Stacks[0].Outputs[?OutputKey==`GatewayUrl`].OutputValue' --output text); \
	COMPLETE=$$($(CFN) describe-stacks --stack-name McpSavvy3loDemoGateway \
		--query 'Stacks[0].Outputs[?OutputKey==`CompleteSessionUrl`].OutputValue' --output text); \
	if [ -z "$$URL" ] || [ -z "$$ISSUER" ]; then \
		printf 'Stacks not deployed yet. Run: make example-gateway-3lo-deploy\n'; \
		exit 1; \
	fi; \
	env -u MCP_SAVVY_CALLBACK_HOST -u MCP_SAVVY_CALLBACK_PORT -u MCP_SAVVY_CALLBACK_PATH -u MCP_SAVVY_PROVIDER -u MCP_SAVVY_SCOPES \
	MCP_SAVVY_REMOTE_URL="$$URL" \
	MCP_SAVVY_OIDC_ISSUER="$$ISSUER" \
	MCP_SAVVY_CLIENT_ID="$$CLIENT" \
	MCP_SAVVY_COMPLETE_SESSION_URL="$$COMPLETE" \
		node packages/cli/dist/cli.js --login

example-gateway-3lo-smoke: build example-gateway-3lo-login ## End-to-end smoke test: list tools (GitHub OpenAPI target)
	@ISSUER=$$($(CFN) describe-stacks --stack-name McpSavvy3loDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`IssuerUrl`].OutputValue' --output text); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvy3loDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text); \
	URL=$$($(CFN) describe-stacks --stack-name McpSavvy3loDemoGateway \
		--query 'Stacks[0].Outputs[?OutputKey==`GatewayUrl`].OutputValue' --output text); \
	COMPLETE=$$($(CFN) describe-stacks --stack-name McpSavvy3loDemoGateway \
		--query 'Stacks[0].Outputs[?OutputKey==`CompleteSessionUrl`].OutputValue' --output text); \
	if [ -z "$$URL" ] || [ -z "$$ISSUER" ]; then \
		printf 'Stacks not deployed yet. Run: make example-gateway-3lo-deploy\n'; \
		exit 1; \
	fi; \
	env -u MCP_SAVVY_CALLBACK_HOST -u MCP_SAVVY_CALLBACK_PORT -u MCP_SAVVY_CALLBACK_PATH -u MCP_SAVVY_PROVIDER -u MCP_SAVVY_SCOPES \
	MCP_SAVVY_REMOTE_URL="$$URL" \
	MCP_SAVVY_OIDC_ISSUER="$$ISSUER" \
	MCP_SAVVY_CLIENT_ID="$$CLIENT" \
	MCP_SAVVY_COMPLETE_SESSION_URL="$$COMPLETE" \
		node scripts/smoke/gateway/3lo.mjs

example-gateway-3lo-logout: build ## Clear cached tokens for the deployed gateway-3lo-mcp stack
	@ISSUER=$$($(CFN) describe-stacks --stack-name McpSavvy3loDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`IssuerUrl`].OutputValue' --output text 2>/dev/null); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvy3loDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text 2>/dev/null); \
	if [ -z "$$ISSUER" ]; then \
		printf 'Stack not deployed yet. Run: make example-gateway-3lo-deploy\n'; exit 1; \
	fi; \
	env -u MCP_SAVVY_CALLBACK_HOST -u MCP_SAVVY_CALLBACK_PORT -u MCP_SAVVY_CALLBACK_PATH -u MCP_SAVVY_PROVIDER -u MCP_SAVVY_SCOPES \
	MCP_SAVVY_REMOTE_URL=https://placeholder.example.com \
	MCP_SAVVY_OIDC_ISSUER="$$ISSUER" \
	MCP_SAVVY_CLIENT_ID="$$CLIENT" \
		node packages/cli/dist/cli.js --logout


# -----------------------------------------------------------------------------
# kb-mcp — protected MCP server backed by a Bedrock Knowledge Base.
# Three stacks: McpSavvyKbDemoCognito + McpSavvyKbDemoKb + McpSavvyKbDemoRuntime.
# Workflow: deploy → sync corpus → ingest → config → add-user → login → smoke.
# -----------------------------------------------------------------------------
KB_CDK := $(PNPM) --filter @mcp-savvy-examples/kb-mcp-infra exec cdk

example-kb-synth: ## Synthesize CloudFormation for the kb-mcp example
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(KB_CDK) synth --strict

example-kb-diff: ## Show pending changes vs deployed kb-mcp stacks
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(KB_CDK) diff

example-kb-deploy: example-kb-diff ## Deploy kb-mcp (Cognito + KB + AgentCore Runtime)
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(KB_CDK) deploy --all --require-approval=never

example-kb-destroy: ## Destroy the kb-mcp stacks
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(KB_CDK) destroy --all --force

example-kb-sync: ## Sync the shared corpus (examples/_shared/kb-corpus/posts/) to the KB source bucket
	@BUCKET=$$($(CFN) describe-stacks --stack-name McpSavvyKbDemoKb \
		--query 'Stacks[0].Outputs[?OutputKey==`SourceBucketName`].OutputValue' --output text); \
	if [ -z "$$BUCKET" ] || [ "$$BUCKET" = "None" ]; then \
		printf 'KB stack not deployed yet. Run: make example-kb-deploy\n'; exit 1; \
	fi; \
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) \
	MCP_SAVVY_KB_SOURCE_BUCKET="$$BUCKET" \
		node examples/kb-mcp/scripts/sync.mjs

example-kb-ingest: ## Trigger a Bedrock KB ingestion job and poll until COMPLETE
	@KB_ID=$$($(CFN) describe-stacks --stack-name McpSavvyKbDemoKb \
		--query 'Stacks[0].Outputs[?OutputKey==`KnowledgeBaseId`].OutputValue' --output text); \
	DS_ID=$$($(CFN) describe-stacks --stack-name McpSavvyKbDemoKb \
		--query 'Stacks[0].Outputs[?OutputKey==`DataSourceId`].OutputValue' --output text); \
	if [ -z "$$KB_ID" ] || [ -z "$$DS_ID" ]; then \
		printf 'KB stack not deployed yet. Run: make example-kb-deploy\n'; exit 1; \
	fi; \
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) \
	MCP_SAVVY_KB_ID="$$KB_ID" MCP_SAVVY_KB_DS_ID="$$DS_ID" \
		node examples/kb-mcp/scripts/ingest.mjs

example-kb-config: ## Print mcp-savvy client config from deployed kb-mcp outputs
	@ISSUER=$$($(CFN) describe-stacks --stack-name McpSavvyKbDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`IssuerUrl`].OutputValue' --output text); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvyKbDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text); \
	ARN=$$($(CFN) describe-stacks --stack-name McpSavvyKbDemoRuntime \
		--query 'Stacks[0].Outputs[?OutputKey==`RuntimeArn`].OutputValue' --output text); \
	REGION=$$($(CFN) describe-stacks --stack-name McpSavvyKbDemoRuntime \
		--query 'Stacks[0].Outputs[?OutputKey==`RuntimeRegion`].OutputValue' --output text); \
	if [ -z "$$ARN" ] || [ -z "$$ISSUER" ]; then \
		printf 'Stacks not deployed yet. Run: make example-kb-deploy\n'; exit 1; \
	fi; \
	ENC=$$(printf '%s' "$$ARN" | sed 's/:/%3A/g; s|/|%2F|g'); \
	URL="https://bedrock-agentcore.$$REGION.amazonaws.com/runtimes/$$ENC/invocations?qualifier=DEFAULT"; \
	printf '\n  \033[1mmcp-savvy kb-mcp client config\033[0m\n\n'; \
	printf '  MCP_SAVVY_REMOTE_URL=%s\n' "$$URL"; \
	printf '  MCP_SAVVY_OIDC_ISSUER=%s\n' "$$ISSUER"; \
	printf '  MCP_SAVVY_CLIENT_ID=%s\n\n' "$$CLIENT"

example-kb-add-user: ## Provision a Cognito user for kb-mcp (EMAIL=name@example.com)
	@if [ -z "$(EMAIL)" ]; then printf 'Usage: make example-kb-add-user EMAIL=name@example.com\n'; exit 1; fi
	@USER_POOL=$$($(CFN) describe-stacks --stack-name McpSavvyKbDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text); \
	$(COGNITO) admin-create-user --user-pool-id "$$USER_POOL" --username "$(EMAIL)" \
		--user-attributes Name=email,Value=$(EMAIL) Name=email_verified,Value=true \
		--desired-delivery-mediums EMAIL

example-kb-login: build ## Run mcp-savvy --login against the deployed kb-mcp stack
	@ISSUER=$$($(CFN) describe-stacks --stack-name McpSavvyKbDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`IssuerUrl`].OutputValue' --output text); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvyKbDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text); \
	ARN=$$($(CFN) describe-stacks --stack-name McpSavvyKbDemoRuntime \
		--query 'Stacks[0].Outputs[?OutputKey==`RuntimeArn`].OutputValue' --output text); \
	REGION=$$($(CFN) describe-stacks --stack-name McpSavvyKbDemoRuntime \
		--query 'Stacks[0].Outputs[?OutputKey==`RuntimeRegion`].OutputValue' --output text); \
	if [ -z "$$ARN" ] || [ -z "$$ISSUER" ]; then \
		printf 'Stacks not deployed yet. Run: make example-kb-deploy\n'; exit 1; \
	fi; \
	ENC=$$(printf '%s' "$$ARN" | sed 's/:/%3A/g; s|/|%2F|g'); \
	URL="https://bedrock-agentcore.$$REGION.amazonaws.com/runtimes/$$ENC/invocations?qualifier=DEFAULT"; \
	env -u MCP_SAVVY_CALLBACK_HOST -u MCP_SAVVY_CALLBACK_PORT -u MCP_SAVVY_CALLBACK_PATH -u MCP_SAVVY_PROVIDER -u MCP_SAVVY_SCOPES \
	MCP_SAVVY_REMOTE_URL="$$URL" \
	MCP_SAVVY_OIDC_ISSUER="$$ISSUER" \
	MCP_SAVVY_CLIENT_ID="$$CLIENT" \
		node packages/cli/dist/cli.js --login

example-kb-smoke: build example-kb-login ## End-to-end kb-mcp smoke test (drives queries.json against ask)
	@ISSUER=$$($(CFN) describe-stacks --stack-name McpSavvyKbDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`IssuerUrl`].OutputValue' --output text); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvyKbDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text); \
	ARN=$$($(CFN) describe-stacks --stack-name McpSavvyKbDemoRuntime \
		--query 'Stacks[0].Outputs[?OutputKey==`RuntimeArn`].OutputValue' --output text); \
	REGION=$$($(CFN) describe-stacks --stack-name McpSavvyKbDemoRuntime \
		--query 'Stacks[0].Outputs[?OutputKey==`RuntimeRegion`].OutputValue' --output text); \
	if [ -z "$$ARN" ] || [ -z "$$ISSUER" ]; then \
		printf 'Stacks not deployed yet. Run: make example-kb-deploy\n'; exit 1; \
	fi; \
	ENC=$$(printf '%s' "$$ARN" | sed 's/:/%3A/g; s|/|%2F|g'); \
	URL="https://bedrock-agentcore.$$REGION.amazonaws.com/runtimes/$$ENC/invocations?qualifier=DEFAULT"; \
	env -u MCP_SAVVY_CALLBACK_HOST -u MCP_SAVVY_CALLBACK_PORT -u MCP_SAVVY_CALLBACK_PATH -u MCP_SAVVY_PROVIDER -u MCP_SAVVY_SCOPES \
	MCP_SAVVY_REMOTE_URL="$$URL" \
	MCP_SAVVY_OIDC_ISSUER="$$ISSUER" \
	MCP_SAVVY_CLIENT_ID="$$CLIENT" \
		node scripts/smoke/kb.mjs

example-kb-logout: build ## Clear cached Cognito tokens for the kb-mcp stack
	@ISSUER=$$($(CFN) describe-stacks --stack-name McpSavvyKbDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`IssuerUrl`].OutputValue' --output text); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvyKbDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text); \
	if [ -z "$$ISSUER" ] || [ -z "$$CLIENT" ]; then \
		printf 'Stack not deployed yet. Run: make example-kb-deploy\n'; exit 1; \
	fi; \
	env -u MCP_SAVVY_CALLBACK_HOST -u MCP_SAVVY_CALLBACK_PORT -u MCP_SAVVY_CALLBACK_PATH -u MCP_SAVVY_PROVIDER -u MCP_SAVVY_SCOPES \
	MCP_SAVVY_REMOTE_URL=https://placeholder.example.com \
	MCP_SAVVY_OIDC_ISSUER="$$ISSUER" \
	MCP_SAVVY_CLIENT_ID="$$CLIENT" \
		node packages/cli/dist/cli.js --logout


# -----------------------------------------------------------------------------
# gateway-kb-mcp — KB MCP with no LLM in the loop (Gateway + Lambda target).
# Stacks: McpSavvyGatewayKbDemoCognito + ...Kb + ...Gateway.
# Workflow: deploy → sync corpus → ingest → config → add-user → login → smoke.
# -----------------------------------------------------------------------------
GW_KB_CDK := $(PNPM) --filter @mcp-savvy-examples/gateway-kb-mcp-infra exec cdk

example-gateway-kb-synth: ## Synthesize CloudFormation for the gateway-kb-mcp example
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(GW_KB_CDK) synth --strict

example-gateway-kb-diff: ## Show pending changes vs deployed gateway-kb-mcp stacks
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(GW_KB_CDK) diff

example-gateway-kb-deploy: example-gateway-kb-diff ## Deploy gateway-kb-mcp (Cognito + KB + Gateway + Lambda KB target)
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(GW_KB_CDK) deploy --all --require-approval=never

example-gateway-kb-destroy: ## Destroy the gateway-kb-mcp stacks
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(GW_KB_CDK) destroy --all --force

example-gateway-kb-sync: ## Sync the shared corpus to the gateway-kb source bucket
	@BUCKET=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayKbDemoKb \
		--query 'Stacks[0].Outputs[?OutputKey==`SourceBucketName`].OutputValue' --output text); \
	if [ -z "$$BUCKET" ] || [ "$$BUCKET" = "None" ]; then \
		printf 'KB stack not deployed yet. Run: make example-gateway-kb-deploy\n'; exit 1; \
	fi; \
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) \
	MCP_SAVVY_KB_SOURCE_BUCKET="$$BUCKET" \
		node examples/kb-mcp/scripts/sync.mjs

example-gateway-kb-ingest: ## Trigger a Bedrock KB ingestion job for gateway-kb and poll until COMPLETE
	@KB_ID=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayKbDemoKb \
		--query 'Stacks[0].Outputs[?OutputKey==`KnowledgeBaseId`].OutputValue' --output text); \
	DS_ID=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayKbDemoKb \
		--query 'Stacks[0].Outputs[?OutputKey==`DataSourceId`].OutputValue' --output text); \
	if [ -z "$$KB_ID" ] || [ -z "$$DS_ID" ]; then \
		printf 'KB stack not deployed yet. Run: make example-gateway-kb-deploy\n'; exit 1; \
	fi; \
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) \
	MCP_SAVVY_KB_ID="$$KB_ID" MCP_SAVVY_KB_DS_ID="$$DS_ID" \
		node examples/kb-mcp/scripts/ingest.mjs

example-gateway-kb-config: ## Print mcp-savvy client config from deployed gateway-kb outputs
	@ISSUER=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayKbDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`IssuerUrl`].OutputValue' --output text); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayKbDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text); \
	URL=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayKbDemoGateway \
		--query 'Stacks[0].Outputs[?OutputKey==`GatewayUrl`].OutputValue' --output text); \
	if [ -z "$$URL" ] || [ -z "$$ISSUER" ]; then \
		printf 'Stacks not deployed yet. Run: make example-gateway-kb-deploy\n'; exit 1; \
	fi; \
	printf '\n  \033[1mmcp-savvy gateway-kb-mcp client config\033[0m\n\n'; \
	printf '  MCP_SAVVY_REMOTE_URL=%s\n' "$$URL"; \
	printf '  MCP_SAVVY_OIDC_ISSUER=%s\n' "$$ISSUER"; \
	printf '  MCP_SAVVY_CLIENT_ID=%s\n\n' "$$CLIENT"

example-gateway-kb-add-user: ## Provision a Cognito user for gateway-kb-mcp (EMAIL=name@example.com)
	@if [ -z "$(EMAIL)" ]; then printf 'Usage: make example-gateway-kb-add-user EMAIL=name@example.com\n'; exit 1; fi
	@USER_POOL=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayKbDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text); \
	$(COGNITO) admin-create-user --user-pool-id "$$USER_POOL" --username "$(EMAIL)" \
		--user-attributes Name=email,Value=$(EMAIL) Name=email_verified,Value=true \
		--desired-delivery-mediums EMAIL

example-gateway-kb-login: build ## Run mcp-savvy --login against the deployed gateway-kb-mcp stack
	@ISSUER=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayKbDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`IssuerUrl`].OutputValue' --output text); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayKbDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text); \
	URL=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayKbDemoGateway \
		--query 'Stacks[0].Outputs[?OutputKey==`GatewayUrl`].OutputValue' --output text); \
	if [ -z "$$URL" ] || [ -z "$$ISSUER" ]; then \
		printf 'Stacks not deployed yet. Run: make example-gateway-kb-deploy\n'; exit 1; \
	fi; \
	env -u MCP_SAVVY_CALLBACK_HOST -u MCP_SAVVY_CALLBACK_PORT -u MCP_SAVVY_CALLBACK_PATH -u MCP_SAVVY_PROVIDER -u MCP_SAVVY_SCOPES \
	MCP_SAVVY_REMOTE_URL="$$URL" \
	MCP_SAVVY_OIDC_ISSUER="$$ISSUER" \
	MCP_SAVVY_CLIENT_ID="$$CLIENT" \
		node packages/cli/dist/cli.js --login

example-gateway-kb-smoke: build example-gateway-kb-login ## End-to-end gateway-kb smoke (drives queries.json through kb_retrieve)
	@ISSUER=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayKbDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`IssuerUrl`].OutputValue' --output text); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayKbDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text); \
	URL=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayKbDemoGateway \
		--query 'Stacks[0].Outputs[?OutputKey==`GatewayUrl`].OutputValue' --output text); \
	if [ -z "$$URL" ] || [ -z "$$ISSUER" ]; then \
		printf 'Stacks not deployed yet. Run: make example-gateway-kb-deploy\n'; exit 1; \
	fi; \
	env -u MCP_SAVVY_CALLBACK_HOST -u MCP_SAVVY_CALLBACK_PORT -u MCP_SAVVY_CALLBACK_PATH -u MCP_SAVVY_PROVIDER -u MCP_SAVVY_SCOPES \
	MCP_SAVVY_REMOTE_URL="$$URL" \
	MCP_SAVVY_OIDC_ISSUER="$$ISSUER" \
	MCP_SAVVY_CLIENT_ID="$$CLIENT" \
		node scripts/smoke/gateway-kb.mjs

example-gateway-kb-logout: build ## Clear cached Cognito tokens for the gateway-kb-mcp stack
	@ISSUER=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayKbDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`IssuerUrl`].OutputValue' --output text); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvyGatewayKbDemoCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text); \
	if [ -z "$$ISSUER" ] || [ -z "$$CLIENT" ]; then \
		printf 'Stack not deployed yet. Run: make example-gateway-kb-deploy\n'; exit 1; \
	fi; \
	env -u MCP_SAVVY_CALLBACK_HOST -u MCP_SAVVY_CALLBACK_PORT -u MCP_SAVVY_CALLBACK_PATH -u MCP_SAVVY_PROVIDER -u MCP_SAVVY_SCOPES \
	MCP_SAVVY_REMOTE_URL=https://placeholder.example.com \
	MCP_SAVVY_OIDC_ISSUER="$$ISSUER" \
	MCP_SAVVY_CLIENT_ID="$$CLIENT" \
		node packages/cli/dist/cli.js --logout


# =============================================================================
# Examples — chatgpt-app-mcp (banking-grade ChatGPT App; step 2 = data stack)
# =============================================================================
# Step 2 ships the data stack only: 3 DynamoDB tables (AWS-managed encryption,
# PITR, deletion protection) + a custom-resource Lambda that seeds
# `customer_data` from `seed/customer-fixtures.json`. The Cognito, network,
# and app stacks are deployed together by the example target.
# -----------------------------------------------------------------------------
CHATGPT_APP_CDK := $(PNPM) --filter @mcp-savvy-examples/chatgpt-app-mcp-infra exec cdk

example-chatgpt-app-synth: ## Synthesize CloudFormation for the chatgpt-app-mcp example
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(CHATGPT_APP_CDK) synth --strict

example-chatgpt-app-diff: ## Show pending changes vs deployed chatgpt-app-mcp stacks
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(CHATGPT_APP_CDK) diff

example-chatgpt-app-deploy: example-chatgpt-app-diff ## Deploy chatgpt-app-mcp (data stack at step 2; more stacks land later)
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(CHATGPT_APP_CDK) deploy --all --require-approval=never

example-chatgpt-app-destroy: ## Destroy the chatgpt-app-mcp stacks (deletion protection on tables blocks teardown by design)
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) $(CHATGPT_APP_CDK) destroy --all --force

example-chatgpt-app-config: ## Print MCP endpoint URL + DynamoDB table names from deployed chatgpt-app-mcp stacks
	@CUSTOMER=$$($(CFN) describe-stacks --stack-name McpSavvyChatGptAppData \
		--query 'Stacks[0].Outputs[?OutputKey==`CustomerDataTableName`].OutputValue' --output text 2>/dev/null); \
	REFS=$$($(CFN) describe-stacks --stack-name McpSavvyChatGptAppData \
		--query 'Stacks[0].Outputs[?OutputKey==`SecureViewRefsTableName`].OutputValue' --output text 2>/dev/null); \
	AUDIT=$$($(CFN) describe-stacks --stack-name McpSavvyChatGptAppData \
		--query 'Stacks[0].Outputs[?OutputKey==`AuditLogTableName`].OutputValue' --output text 2>/dev/null); \
	URL=$$($(CFN) describe-stacks --stack-name McpSavvyChatGptAppApp \
		--query 'Stacks[0].Outputs[?OutputKey==`PublicUrl`].OutputValue' --output text 2>/dev/null); \
	MCP=$$($(CFN) describe-stacks --stack-name McpSavvyChatGptAppApp \
		--query 'Stacks[0].Outputs[?OutputKey==`McpEndpoint`].OutputValue' --output text 2>/dev/null); \
	ISSUER=$$($(CFN) describe-stacks --stack-name McpSavvyChatGptAppCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`IssuerUrl`].OutputValue' --output text 2>/dev/null); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvyChatGptAppCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text 2>/dev/null); \
	SCOPE=$$($(CFN) describe-stacks --stack-name McpSavvyChatGptAppCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`BalanceReadScope`].OutputValue' --output text 2>/dev/null); \
	if [ -z "$$CUSTOMER" ] || [ "$$CUSTOMER" = "None" ]; then \
		printf 'Data stack not deployed yet. Run: make example-chatgpt-app-deploy\n'; exit 1; \
	fi; \
	printf '\n  \033[1mmcp-savvy chatgpt-app-mcp\033[0m\n\n'; \
	if [ -n "$$URL" ] && [ "$$URL" != "None" ]; then \
		printf '  \033[1mPublic URL\033[0m       %s\n' "$$URL"; \
		printf '  \033[1mMCP endpoint\033[0m     %s   <-- paste into ChatGPT connector\n' "$$MCP"; \
	else \
		printf '  App stack not deployed yet — run: make example-chatgpt-app-deploy\n'; \
	fi; \
	printf '\n  Cognito issuer:   %s\n' "$$ISSUER"; \
	printf '  Cognito client:   %s\n' "$$CLIENT"; \
	printf '  Required scope:   %s\n' "$$SCOPE"; \
	printf '\n  DynamoDB tables:\n'; \
	printf '    customer_data:    %s\n' "$$CUSTOMER"; \
	printf '    secure_view_refs: %s\n' "$$REFS"; \
	printf '    audit_log:        %s\n\n' "$$AUDIT"

example-chatgpt-app-add-user: ## Provision a Cognito user for chatgpt-app-mcp (EMAIL=name@example.com); requires the cognito stack (lands later)
	@if [ -z "$(EMAIL)" ]; then printf 'Usage: make example-chatgpt-app-add-user EMAIL=name@example.com\n'; exit 1; fi
	@USER_POOL=$$($(CFN) describe-stacks --stack-name McpSavvyChatGptAppCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text 2>/dev/null); \
	if [ -z "$$USER_POOL" ] || [ "$$USER_POOL" = "None" ]; then \
		printf 'Cognito stack not deployed yet. Run: make example-chatgpt-app-deploy\n'; exit 1; \
	fi; \
	$(COGNITO) admin-create-user --user-pool-id "$$USER_POOL" --username "$(EMAIL)" \
		--user-attributes Name=email,Value=$(EMAIL) Name=email_verified,Value=true \
		--desired-delivery-mediums EMAIL

example-chatgpt-app-add-callback: ## Append a callback URL to the Cognito client (CALLBACK=https://chatgpt.com/connector/oauth/...)
	@if [ -z "$(CALLBACK)" ]; then printf 'Usage: make example-chatgpt-app-add-callback CALLBACK=https://chatgpt.com/connector/oauth/<id>\n'; exit 1; fi
	@USER_POOL=$$($(CFN) describe-stacks --stack-name McpSavvyChatGptAppCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text 2>/dev/null); \
	CLIENT=$$($(CFN) describe-stacks --stack-name McpSavvyChatGptAppCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`HumanClientId`].OutputValue' --output text 2>/dev/null); \
	if [ -z "$$CLIENT" ] || [ "$$CLIENT" = "None" ]; then \
		printf 'Cognito stack not deployed yet. Run: make example-chatgpt-app-deploy\n'; exit 1; \
	fi; \
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) \
	USER_POOL="$$USER_POOL" CLIENT="$$CLIENT" CALLBACK="$(CALLBACK)" \
		$(NODE) examples/chatgpt-app-mcp/scripts/add-callback.mjs

example-chatgpt-app-seed-customers: ## Seed customer_data from live Cognito users (idempotent; FORCE=1 overwrites)
	@USER_POOL=$$($(CFN) describe-stacks --stack-name McpSavvyChatGptAppCognito \
		--query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text 2>/dev/null); \
	CUSTOMER=$$($(CFN) describe-stacks --stack-name McpSavvyChatGptAppData \
		--query 'Stacks[0].Outputs[?OutputKey==`CustomerDataTableName`].OutputValue' --output text 2>/dev/null); \
	if [ -z "$$USER_POOL" ] || [ "$$USER_POOL" = "None" ] || [ -z "$$CUSTOMER" ] || [ "$$CUSTOMER" = "None" ]; then \
		printf 'Cognito + Data stacks must be deployed first. Run: make example-chatgpt-app-deploy\n'; exit 1; \
	fi; \
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) \
	USER_POOL="$$USER_POOL" CUSTOMER_TABLE="$$CUSTOMER" FORCE="$(FORCE)" \
		$(NODE) examples/chatgpt-app-mcp/scripts/seed-customers-from-cognito.mjs

# =============================================================================
# Architecture animation (Remotion) — examples/chatgpt-app-mcp/docs/architecture/animation
# Standalone npm project (NOT a pnpm workspace member). Installs ~600 MB of
# Remotion + Chromium-for-testing into the subdir's own node_modules. Output
# is gitignored.
# =============================================================================

ANIMATION_DIR := examples/chatgpt-app-mcp/docs/architecture/animation

example-chatgpt-app-animation-install: ## Install Remotion deps into the animation subdir (one-time, ~600 MB)
	@cd $(ANIMATION_DIR) && pnpm install --ignore-workspace

example-chatgpt-app-animation-render: example-chatgpt-app-animation-install ## Render Pattern D animation to MP4 (out/pattern-d.mp4)
	@cd $(ANIMATION_DIR) && pnpm render

example-chatgpt-app-animation-gif: example-chatgpt-app-animation-install ## Render Pattern D animation to animated GIF (out/pattern-d.gif)
	@cd $(ANIMATION_DIR) && pnpm run render:gif

example-chatgpt-app-animation-studio: example-chatgpt-app-animation-install ## Open the Remotion Studio live preview at http://localhost:3000
	@cd $(ANIMATION_DIR) && pnpm studio

example-chatgpt-app-animation-clean: ## Remove the animation subdir's node_modules + rendered output
	@rm -rf $(ANIMATION_DIR)/node_modules $(ANIMATION_DIR)/out $(ANIMATION_DIR)/.cache
