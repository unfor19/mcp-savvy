"""Shared input, invocation, and output bounds for the agentic KB example."""

from __future__ import annotations

from typing import Any

MAX_PROMPT_CHARS = 4096
MIN_OUTPUT_TOKENS = 128
DEFAULT_OUTPUT_TOKENS = 2000
MAX_OUTPUT_TOKENS = 4096
MAX_AGENT_TURNS = 4
MAX_TOTAL_TOKENS = 12_000
MAX_ANSWER_CHARS = 16_384
MAX_SOURCES = 10
MAX_SOURCE_URL_CHARS = 2048


def normalize_prompt(value: Any) -> str:
    """Return a trimmed prompt or raise when its public contract is violated."""
    if not isinstance(value, str):
        raise ValueError("prompt must be a string")
    prompt = value.strip()
    if not prompt or len(prompt) > MAX_PROMPT_CHARS:
        raise ValueError(f"prompt must contain 1-{MAX_PROMPT_CHARS} characters")
    return prompt


def parse_output_token_limit(value: str | None) -> int:
    """Parse the model output limit while rejecting unsafe deployment values."""
    raw = value if value is not None else str(DEFAULT_OUTPUT_TOKENS)
    try:
        parsed = int(raw)
    except ValueError as exc:
        raise ValueError("MCP_SAVVY_KB_MAX_TOKENS must be an integer") from exc
    if parsed < MIN_OUTPUT_TOKENS or parsed > MAX_OUTPUT_TOKENS:
        raise ValueError(
            f"MCP_SAVVY_KB_MAX_TOKENS must be {MIN_OUTPUT_TOKENS}-{MAX_OUTPUT_TOKENS}",
        )
    return parsed


def invocation_limits(output_tokens: int) -> dict[str, int]:
    """Build Strands invocation limits for one bounded agent call."""
    return {
        "turns": MAX_AGENT_TURNS,
        "output_tokens": output_tokens,
        "total_tokens": MAX_TOTAL_TOKENS,
    }


def bounded_answer(value: Any) -> str:
    """Return a user-facing answer capped to the response budget."""
    text = value if isinstance(value, str) else ""
    if len(text) <= MAX_ANSWER_CHARS:
        return text
    return f"{text[:MAX_ANSWER_CHARS]}\u2026"


def bounded_sources(value: Any) -> list[dict[str, str]]:
    """Return at most ten bounded HTTP source URLs."""
    sources: list[dict[str, str]] = []
    if not isinstance(value, list):
        return sources
    for source in value:
        if len(sources) >= MAX_SOURCES:
            break
        if not isinstance(source, dict):
            continue
        url = source.get("url") or source.get("source_url")
        if isinstance(url, str) and url.startswith(("http://", "https://")):
            sources.append({"url": url[:MAX_SOURCE_URL_CHARS]})
    return sources
