# Shared KB corpus

Knowledge-base content used by the `kb-mcp` and `gateway-kb-mcp`
examples. The content is a curated selection of blog posts from
[meirg.co.il](https://meirg.co.il), authored by Meir Gabay.

## Layout

- `posts/*.md` — one markdown file per blog post. YAML
  frontmatter carries `title`, `url`, `published`, `tags`,
  `read_minutes`, `author`, and `source`.
- `queries.json` — verification queries for the smoke test
  (see below).
- `README.md` — this file.

## Why this corpus

Synthetic test corpora ("Acme Corp's onboarding handbook") read as
fake. A canonical AWS-content corpus risks the LLM answering from
training data without retrieval. **Real, niche, authored-by-the-
project-owner content** sits in the sweet spot: the LLM almost
certainly hasn't memorized it (small personal site), so an answer
that contains specific facts from these posts is provably grounded
in retrieval.

## Verification

Each query in `queries.json` carries:

- `question` — what the host LLM asks the agent
- `expected_substring` — a fragment that must appear in the agent's
  answer for the query to count as passing (substring of unique
  content from the corpus that the LLM could not have produced
  without retrieval)
- `source_url` — the canonical post the answer should cite

The smoke test loops every query, asserts every `expected_substring`
appears in the response. If the LLM passes without retrieval running,
something is wrong upstream.

## Replacing the corpus

To use this example with your own content, replace the `.md`
files under `posts/` and regenerate `queries.json`. Keep the
frontmatter shape — the agent uses it for citations.
