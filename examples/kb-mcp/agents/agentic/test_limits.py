"""Unit tests for agentic KB request and response bounds."""

import unittest

from limits import (
    MAX_ANSWER_CHARS,
    MAX_PROMPT_CHARS,
    bounded_answer,
    bounded_sources,
    invocation_limits,
    normalize_prompt,
    parse_output_token_limit,
)


class LimitsTest(unittest.TestCase):
    """Exercise limits without importing runtime-only dependencies."""

    def test_prompt_is_trimmed_and_bounded(self) -> None:
        """Reject empty and oversized prompts before model work starts."""
        self.assertEqual(normalize_prompt("  hello  "), "hello")
        for invalid in ("", "x" * (MAX_PROMPT_CHARS + 1), None):
            with self.assertRaises(ValueError):
                normalize_prompt(invalid)

    def test_output_token_limit_is_range_checked(self) -> None:
        """Reject malformed and out-of-range deployment configuration."""
        self.assertEqual(parse_output_token_limit(None), 2000)
        self.assertEqual(parse_output_token_limit("128"), 128)
        for invalid in ("bad", "127", "4097"):
            with self.assertRaises(ValueError):
                parse_output_token_limit(invalid)

    def test_invocation_limits_bound_turns_and_tokens(self) -> None:
        """Pass all three Strands cost bounds for every invocation."""
        self.assertEqual(
            invocation_limits(1000),
            {"turns": 4, "output_tokens": 1000, "total_tokens": 12_000},
        )

    def test_response_fields_are_bounded(self) -> None:
        """Cap model text and source URLs before returning them."""
        self.assertEqual(len(bounded_answer("x" * (MAX_ANSWER_CHARS + 1))), MAX_ANSWER_CHARS + 1)
        sources = bounded_sources([{"url": f"https://example.com/{index}"} for index in range(20)])
        self.assertEqual(len(sources), 10)


if __name__ == "__main__":
    unittest.main()
