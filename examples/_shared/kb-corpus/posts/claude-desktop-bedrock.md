---
title: "What Claude Desktop Sends to Amazon Bedrock"
url: "https://meirg.co.il/2026/05/06/what-claude-desktop-sends-to-amazon-bedrock/"
published: "2026-05-06"
tags: ["claude", "amazon-bedrock", "aws", "ai", "cloudwatch"]
read_minutes: 5
author: "Meir Gabay"
source: "meirg.co.il"
---

# What Claude Desktop Sends to Amazon Bedrock

If you're using Claude Desktop in Bring-Your-Own-Bedrock (BYO)
mode, the obvious question is: what exactly gets sent to Amazon
Bedrock on every turn?

I went through a real CloudWatch model-invocation export from a
Claude Desktop session captured on **May 5, 2026**. The answer is
refreshingly un-mysterious: Claude Desktop sends a standard
Anthropic Messages API payload over Bedrock, including the full
system prompt, tool definitions, and conversation history on
every request.

> **Scope note**: this post is grounded in one observed Claude
> Desktop BYO-Bedrock session captured in CloudWatch on
> May 5, 2026. It explains what this deployment mode sends; it
> does not claim every Anthropic product path behaves identically.

## TL;DR — what leaves your machine

- Claude Desktop talks to Bedrock through `InvokeModelWithResponseStream`.
- The payload shape is the standard Anthropic Messages API:
  `system`, `messages`, `tools`, `max_tokens`, `temperature`, etc.
- The API is **stateless** — the full conversation context is
  re-sent on every turn.
- Prompt caching with `cache_control: { type: "ephemeral" }`
  reduces recompute and billing, but **does not hide the full
  prompt** from Bedrock or CloudWatch model-invocation logs.
- Tool execution happens **locally** on the client. Bedrock only
  sees the `tool_use` request and the `tool_result` content the
  client sends back later.
- In BYO-Bedrock mode, the request lands in **your** AWS account
  and region.

## The mental model most people get wrong

The biggest misconception is thinking Claude Desktop sends only
the latest user message while Bedrock keeps session state on the
server side.

That is **not** what the observed request flow shows.

Claude Desktop treats each Bedrock call as a fresh, self-contained
request. Every turn includes:

- the system prompt
- the available tool definitions
- the full message history
- the latest user input or latest tool result

Bedrock stores nothing between turns for this flow. The client
rebuilds and re-sends the full context every time.

## What the system prompt actually contains

On every observed call, the `system` array had three main blocks:

### 1. A billing and entrypoint tag

```
x-anthropic-billing-header: cc_version=2.1.121.540; cc_entrypoint=claude-desktop-3p;
```

The important part is `cc_entrypoint=claude-desktop-3p`, which
marks the traffic as Claude Desktop running against the customer's
own Bedrock account.

### 2. A short agent identity line

```
You are a Claude agent, built on Anthropic's Claude Agent SDK.
```

### 3. The Claude Agent SDK system prompt

The observed prompt was about **25K characters long** and marked
with `cache_control: ephemeral`. It includes the usual agent
instructions you'd expect from a coding assistant: tool-use rules,
output-formatting rules, permission-mode behavior, security and
refusal guidance, URL guardrails, context-management guidance,
and model metadata.

The key point isn't the size — it's the **visibility**. This text
is plain request content, not a hidden opaque layer outside
Bedrock's logging surface.

## Prompt caching saves money, not visibility

Claude Desktop uses prompt caching aggressively, but caching does
not mean "only a tiny delta is sent to Bedrock." It means Bedrock
can re-use previously cached prefix work instead of re-processing
and re-billing the stable portion of the request.

The observed token pattern over a multi-turn session showed:

- Turn 1 writes the big reusable prefix into cache.
- Later turns read that prefix back from cache.
- Small later `cache_creation_input_tokens` values reflect new
  history being folded into the cache.

The most important operational takeaway:

> Prompt caching changes billing and recomputation, not wire
> visibility.

The full prompt still belongs to the request envelope. With
model-invocation logging enabled, Bedrock can log what it
received (subject to body-size truncation limits).

Two more details that matter:

- **Cache keys are prefix-sensitive**. A single change near the
  top can invalidate the whole cache.
- The observed flow used `ephemeral_5m` and `ephemeral_1h` style
  TTL behavior to survive longer idle periods.

## Tool calls are local until you send the result back

Bedrock does not directly watch local tool execution. What it
sees is:

1. A `tool_use` block in the assistant output.
2. A later `tool_result` block the client includes in the next
   request.

So the model can ask for `Read`, `Edit`, `Bash`, or MCP-style
tools, but **Bedrock itself only receives the structured content
the client chooses to send back** in the next turn.

## What is NOT sent

Based on the observed session:

- No raw filesystem contents are sent unless the client first
  reads them and includes them in a `tool_result`.
- No AWS credentials or secret tokens were visible in the request
  structure.
- The billing header is a plain identifier, not an auth secret.
- Cache, logs, and billing stay scoped to the customer's AWS
  account and region in this BYO-Bedrock path.

"Claude Desktop can use local files and tools" is not the same as
"Bedrock automatically receives your local machine state." The
latter only happens when the client intentionally forwards
content.

## How to verify this yourself

1. Enable Bedrock model-invocation logging to CloudWatch Logs or
   S3 in the relevant AWS account and region.
2. Run Claude Desktop against Bedrock in BYO mode.
3. Inspect the captured request JSON.
4. Look specifically for: the `system` array, the full `messages`
   history, `cache_control` markers, token-accounting fields, and
   the `cc_entrypoint=claude-desktop-3p` header.

Once you do that, the architecture becomes much easier to reason
about. You can stop debating from screenshots and inspect the
actual wire payload.

## Final thought

Claude Desktop on BYO-Bedrock is not hiding some magical
proprietary request shape. It sends a standard, inspectable
Anthropic-style messages payload to Bedrock, re-sends full context
on every turn, and relies on prompt caching to make that
affordable.

Great news if you care about transparency, logging, and
understanding exactly what your AI tooling is doing inside your
own AWS account.
