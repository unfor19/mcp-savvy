"""mcp-savvy minimal-mcp demo agent — MCP echo server.

The smallest agent that proves the mcp-savvy stdio bridge works
end-to-end against AgentCore Runtime + Cognito. Exposes one tool,
`echo`, that returns its input verbatim. No Bedrock model, no
knowledge base — just enough to show the protected MCP path.

AgentCore Runtime contract for MCP servers:
- Streamable-HTTP transport on port 8000, mount path /mcp
- stateless_http=True so AgentCore's session header is honored
- Container listens on 0.0.0.0
"""

from __future__ import annotations

import logging
import os

from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
logger = logging.getLogger("mcp-savvy-demo")

PORT = int(os.environ.get("PORT", "8000"))

mcp = FastMCP(
    name="mcp-savvy-demo",
    instructions=(
        "Demo MCP server for the mcp-savvy minimal-mcp example. "
        "Call `echo` with a `message` and get the same string back. "
        "Used to validate end-to-end auth + transport, not for real work."
    ),
    host="0.0.0.0",  # noqa: S104 - container bind required by AgentCore
    port=PORT,
    streamable_http_path="/mcp",
    stateless_http=True,
    json_response=True,
)


@mcp.tool(
    name="echo",
    description=(
        "Return the input `message` verbatim. Used to verify the "
        "mcp-savvy bridge → Cognito → AgentCore Runtime path is "
        "wired correctly."
    ),
)
def echo(message: str) -> dict[str, str]:
    """Echo the input back to the caller."""
    safe = message if isinstance(message, str) else str(message)
    logger.info("echo len=%d", len(safe))
    return {"echo": safe}


def main() -> None:
    """Start the FastMCP server on the AgentCore-expected transport."""
    mcp.run(transport="streamable-http")


if __name__ == "__main__":
    main()
