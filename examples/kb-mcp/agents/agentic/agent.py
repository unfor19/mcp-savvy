"""mcp-savvy kb-mcp — agentic flavor.

Strands agent over a Bedrock Knowledge Base. Exposes one outward
MCP tool, `ask`, that runs a Strands agent with a single internal
tool, `kb_retrieve`. The agent's system prompt instructs it to
ground answers solely on the KB and to refuse when the KB has
nothing relevant — same pattern as `.vanguard` and `.genia`.

Wire-level user envelope:
    { answer: str, sources: [{ url: str }], confidence: high|medium|low|none }

AgentCore Runtime contract:
  - Streamable-HTTP transport on port 8000, mount path /mcp
  - stateless_http=True so AgentCore's session header is honored
  - Container listens on 0.0.0.0
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP
from strands import Agent
from strands.models.bedrock import BedrockModel

from limits import (
    bounded_answer,
    bounded_sources,
    invocation_limits,
    normalize_prompt,
    parse_output_token_limit,
)
from tools import kb_retrieve

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
logger = logging.getLogger("mcp-savvy-kb-agentic")

REGION = os.environ.get("AWS_REGION", "us-east-1")
MODEL_ID = os.environ.get(
    "MCP_SAVVY_KB_MODEL_ID",
    "us.anthropic.claude-sonnet-4-6",
)
MAX_TOKENS = parse_output_token_limit(os.environ.get("MCP_SAVVY_KB_MAX_TOKENS"))
PORT = int(os.environ.get("PORT", "8000"))

SYSTEM_PROMPT = (Path(__file__).parent / "system_prompt.md").read_text(encoding="utf-8")

# Module-level Bedrock model — boto3 clients are thread-safe once
# created. A new Strands `Agent` is built per tool call so its
# mutable `messages` list is never shared between requests.
_model = BedrockModel(
    model_id=MODEL_ID,
    region_name=REGION,
    max_tokens=MAX_TOKENS,
)

mcp = FastMCP(
    name="mcp-savvy-kb",
    instructions=(
        "KB-grounded MCP agent over a Bedrock Knowledge Base. Call "
        "`ask` with a natural-language question. Returns "
        "{answer, sources:[{url}], confidence}. Confidence is one "
        "of high|medium|low|none — `none` means the agent could "
        "not ground the answer in the knowledge base."
    ),
    host="0.0.0.0",  # noqa: S104 - container bind required by AgentCore
    port=PORT,
    streamable_http_path="/mcp",
    stateless_http=True,
    json_response=True,
)


_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)


def _parse_model_output(text: str) -> dict[str, Any]:
    """Parse the Strands agent's text response into the envelope dict.

    The agent is system-prompted to return a JSON object, but model
    outputs occasionally wrap it in a ``` fence or skip the wrapper
    entirely. Try both, fall back to a low-confidence wrapper.
    """
    candidate = text.strip()
    fenced = _FENCE_RE.search(candidate)
    if fenced:
        candidate = fenced.group(1)
    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError:
        return {
            "answer": text.strip(),
            "sources": [],
            "confidence": "low",
            "_warning": "non_json",
        }
    if not isinstance(parsed, dict):
        return {
            "answer": text.strip(),
            "sources": [],
            "confidence": "low",
            "_warning": "non_object",
        }
    parsed.setdefault("answer", "")
    parsed.setdefault("sources", [])
    parsed.setdefault("confidence", "low")
    return parsed


def _build_user_envelope(raw: dict[str, Any]) -> dict[str, Any]:
    """Strip internal paths / scores; keep only HTTPS-bearing sources."""
    confidence = raw.get("confidence", "low")
    if confidence not in {"high", "medium", "low", "none"}:
        confidence = "low"
    return {
        "answer": bounded_answer(raw.get("answer")),
        "sources": bounded_sources(raw.get("sources")),
        "confidence": confidence,
    }


@mcp.tool(
    name="ask",
    description=(
        "Ask a natural-language question of the Bedrock Knowledge "
        "Base. Returns {answer, sources:[{url}], confidence}. "
        "Confidence values: high (multiple grounded chunks), medium "
        "(single grounded chunk), low (partial ground), none (KB "
        "had no relevant content; the agent refused to answer)."
    ),
)
def ask(prompt: str) -> dict[str, Any]:
    """Forward `prompt` to the Strands agent and return the envelope."""
    try:
        normalized_prompt = normalize_prompt(prompt)
    except ValueError as exc:
        return {
            "answer": str(exc),
            "sources": [],
            "confidence": "none",
        }
    logger.info("ask prompt_len=%d", len(normalized_prompt))

    agent = Agent(
        model=_model,
        tools=[kb_retrieve],
        system_prompt=SYSTEM_PROMPT,
        callback_handler=None,
    )
    result = agent(normalized_prompt, limits=invocation_limits(MAX_TOKENS))
    raw = _parse_model_output(str(result))

    logger.info(
        "ask_debug answer_len=%d confidence=%s source_count=%d",
        len(raw.get("answer", "")),
        raw.get("confidence"),
        len(raw.get("sources", [])),
    )
    return _build_user_envelope(raw)


def main() -> None:
    """Start the FastMCP server on the AgentCore-expected transport."""
    logger.info(
        "starting kb-agentic agent kb_id=%s region=%s model=%s",
        os.environ.get("MCP_SAVVY_KB_ID", "(unset)"),
        REGION,
        MODEL_ID,
    )
    mcp.run(transport="streamable-http")


if __name__ == "__main__":
    main()
