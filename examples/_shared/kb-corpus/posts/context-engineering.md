---
title: "AI Code Generation, Smarter and More Cost-Efficient with Context Engineering"
url: "https://meirg.co.il/2025/07/18/ai-code-generation-smarter-and-cost-efficient-with-context-engineering/"
published: "2025-07-18"
tags: ["ai", "code-generation", "context-engineering", "prompt-engineering"]
read_minutes: 6
author: "Meir Gabay"
source: "meirg.co.il"
---

# AI Code Generation, Smarter and More Cost-Efficient with Context Engineering

We've all hit that wall: endless tweaks to prompts, fixing
AI-generated bugs, and wondering why such powerful tech feels so
hit-or-miss. It often feels like working with a brilliant but
forgetful junior developer who hasn't been onboarded to your
project.

The problem isn't the model's power. It's the context we give it
— or don't give it.

[Research shows](https://arxiv.org/abs/2406.10279) models hallucinate
packages: at least **5.2%** of suggested packages from commercial
models and **21.7%** from open-source models don't exist.

## The high cost of runtime research

When an AI assistant lacks a high-level overview of your project,
it's forced to build one on the fly. It skims your files, piecing
together architecture, dependencies, conventions. This "runtime
research" is slow and expensive — every file read adds tokens to
your API call, which translates directly to higher costs.

Worse, the results are often suboptimal. The AI might generate
code that works in isolation but clashes with your existing
patterns, ignores crucial utility functions, or re-invents a
wheel you already have spinning smoothly elsewhere.

## The solution: a `DETAILS.md` file

A `DETAILS.md` file is a concise, high-level "cheat sheet" for
your AI assistant. Think of it as the onboarding document you'd
give a new human developer.

A great `DETAILS.md` typically includes:

- **Project Overview**: what does it do, what problem does it
  solve, who are the target users?
- **Architecture**: high-level structure (microservices, monolith,
  MVC). A link to a diagram is a huge plus.
- **Key Components**: most important files, directories, modules,
  classes, and their purpose.
- **Coding Conventions & Stack**: languages and versions
  (`Python 3.11`), frameworks (`Express v4`), patterns, libraries,
  style guides (`PEP 8`).
- **"How-To" Guides**: simple instructions for common tasks like
  running tests, setting up the environment, interacting with the
  database.

By providing this upfront, you stop treating your AI like a
black box and start treating it like a team member.

## Why it matters — measurable improvements

| Dimension                  | Before                    | After                                            |
| -------------------------- | ------------------------- | ------------------------------------------------ |
| Code quality & accuracy    | Frequent hallucinations   | Lower complexity, fewer code-smell warnings      |
| Cost & token consumption   | High token use            | Prompts stay short, dramatic spend cuts          |
| Development time           | Endless prompt-fix-repeat | Tasks finish faster, junior devs ramp up in days |
| Project-specific adherence | Ignores patterns          | Suggestions follow your architecture             |

## One context to rule them all: symlinking

Instead of maintaining separate `CLAUDE.md` (Claude Code),
`GEMINI.md` (Gemini CLI), and `AGENTS.md` (OpenAI Codex) files,
generate a single canonical `DETAILS.md` and symlink the rest to
it:

```bash
ln -s DETAILS.md CLAUDE.md   # Claude Code
ln -s DETAILS.md GEMINI.md   # Gemini CLI
ln -s DETAILS.md AGENTS.md   # OpenAI Codex
```

For IDEs like Cursor or Windsurf, add a rule:

```
ALWAYS read @DETAILS.md before taking any action to get context.
```

Every agent gets the same up-to-date context without duplication.
Write once, inform everywhere.

## Context Rot: why a focused file beats dumping everything

LLMs don't read like humans do. We assume that pasting a bunch of
files into the prompt means the model reads everything equally.
That's not what happens. Multiple studies confirm models pay the
most attention to the **very beginning** and **very end** of the
context window. Information in the middle has a much higher
chance of being ignored — the **"lost-in-the-middle"** problem.

This is **Context Rot**. The longer and more unfocused your
context is, the more likely the AI gets lost. A million-token
context window is useless if it's mostly irrelevant noise that
drowns out the signal.

A concise `DETAILS.md` is often more effective than dumping your
entire codebase. The goal isn't more information — it's **more
relevant information, placed strategically where the model will
see it**.

## The takeaway

If you're frustrated with AI coding tools, don't blame the model.
The biggest gains in code quality, speed, and cost-efficiency
don't come from switching to the latest LLM. They come from
mastering context engineering.

Start small. Create a `DETAILS.md` for your current project. Be
explicit about architecture and standards. Watch your AI assistant
transform from a clumsy intern into a reliable team member.
