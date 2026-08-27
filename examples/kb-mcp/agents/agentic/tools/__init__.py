"""Internal Strands tools for the mcp-savvy kb-mcp agent.

The single internal tool is `kb_retrieve`. It wraps Bedrock KB
Retrieve and returns chunks plus the per-chunk metadata
(`url`, `title`, `published`, `tags`, `source`) carried by the
markdown frontmatter of each post in `examples/_shared/kb-corpus/posts/`.
"""

from .kb import kb_retrieve

__all__ = ["kb_retrieve"]
