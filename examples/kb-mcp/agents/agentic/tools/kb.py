"""kb_retrieve: semantic search over the mcp-savvy Bedrock KB.

Wraps `bedrock-agent-runtime:Retrieve`. Returns chunks plus the
per-chunk metadata so the agent can cite the source URL on every
claim.

The agent's system prompt forbids ungrounded answers, so every
chunk we surface here MUST carry a `url` for citation. The corpus
loader injects YAML frontmatter (`url`, `title`, `published`, ...)
into per-document metadata at sync time — see the kb-sync script.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import boto3
from strands import tool

logger = logging.getLogger(__name__)

DEFAULT_KB_ID = os.environ.get("MCP_SAVVY_KB_ID", "")
DEFAULT_REGION = os.environ.get("AWS_REGION", "us-east-1")
MAX_QUERY_CHARS = 4096
MAX_RESULTS = 20
MAX_CHUNK_CHARS = 8192

# Module-level client is initialized lazily on first call so the
# container can start without credentials being resolved at import
# time. boto3 clients are thread-safe once created.
_runtime: Any = None


def _get_runtime() -> Any:
    """Return a process-wide bedrock-agent-runtime client."""
    global _runtime
    if _runtime is None:
        _runtime = boto3.client("bedrock-agent-runtime", region_name=DEFAULT_REGION)
    return _runtime


@tool
def kb_retrieve(query: str, k: int = 8) -> dict[str, Any]:
    """Search the Bedrock Knowledge Base by vector similarity.

    Use this for any question about content the user might have
    indexed. The KB is the authoritative source — your answer
    must be grounded in what comes back.

    Args:
        query: Natural-language question or keyword phrase.
        k: How many chunks to return. Default 8. Drop to 3-4 for
            highly specific questions; bump to 10+ for broad ones.
            (The default is 8 because exact-token answers sometimes
            rank at position 6-8 even when the right document tops
            the list — verified live against this corpus.)

    Returns:
        A dict shaped as:
            {
              "results": [
                {
                  "content": "<chunk text>",
                  "score": 0.42,
                  "location": { "s3Location": { "uri": "s3://..." } },
                  "metadata": {
                    "url": "https://...",
                    "title": "...",
                    "published": "...",
                    "tags": [...],
                    "source": "..."
                  }
                },
                ...
              ],
              "count": <int>
            }
        `score` is the vector-similarity score; higher is better.
        `metadata.url` is the canonical HTTPS URL the agent cites
        in the user-facing sources array.
    """
    normalized_query = query.strip() if isinstance(query, str) else ""
    if not normalized_query or len(normalized_query) > MAX_QUERY_CHARS:
        return {"results": [], "count": 0, "error": "query must contain 1-4096 characters"}
    if not isinstance(k, int) or isinstance(k, bool) or k < 1 or k > MAX_RESULTS:
        return {"results": [], "count": 0, "error": "k must be an integer from 1-20"}
    if not DEFAULT_KB_ID:
        return {
            "results": [],
            "count": 0,
            "error": "MCP_SAVVY_KB_ID is not set; the runtime cannot reach the KB.",
        }

    try:
        resp = _get_runtime().retrieve(
            knowledgeBaseId=DEFAULT_KB_ID,
            retrievalQuery={"text": normalized_query},
            retrievalConfiguration={
                "vectorSearchConfiguration": {"numberOfResults": k},
            },
        )
    except Exception as exc:  # noqa: BLE001 - provider errors become stable tool errors
        logger.error(
            "kb_retrieve failed query_len=%d k=%d error_type=%s",
            len(normalized_query),
            k,
            type(exc).__name__,
        )
        return {"results": [], "count": 0, "error": "knowledge-base retrieval failed"}

    out: list[dict[str, Any]] = []
    for hit in resp.get("retrievalResults", []):
        text = hit.get("content", {}).get("text", "")[:MAX_CHUNK_CHARS]
        score = hit.get("score", 0.0)
        meta = hit.get("metadata", {}) or {}
        out.append(
            {
                "content": text,
                "score": round(float(score), 4),
                "location": hit.get("location", {}),
                "metadata": meta,
            },
        )
    return {"results": out, "count": len(out)}
