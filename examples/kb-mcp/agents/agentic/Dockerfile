# syntax=docker/dockerfile:1.7
# mcp-savvy kb-mcp agentic flavor — ARM64 image for AgentCore Runtime.
#
# AgentCore Runtime contract:
#   - Architecture: linux/arm64
#   - MCP servers listen on port 8000 (HTTP runtimes use 8080)
#   - Mount path /mcp, stateless_http=True
#
# CDK builds and pushes this image automatically via
# `agentcore.AgentRuntimeArtifact.fromAsset(<this dir>)`.

FROM --platform=$TARGETPLATFORM ghcr.io/astral-sh/uv:python3.12-bookworm-slim@sha256:e5b65587bce7de595f299855d7385fe7fca39b8a74baa261ba1b7147afa78e58

ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_NO_CACHE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Install deps first so this layer caches across code edits.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Copy the agent code.
COPY agent.py limits.py system_prompt.md ./
COPY tools ./tools

EXPOSE 8000

CMD ["uv", "run", "--frozen", "--no-dev", "python", "agent.py"]
