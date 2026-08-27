/**
 * AgentCore Gateway Lambda target for the gateway-lambda-mcp demo.
 *
 * Exposes two trivial tools:
 *   - getCurrentTime: return the current ISO-8601 timestamp, optionally
 *     in a caller-specified IANA timezone.
 *   - summarizeText: return a deterministic, model-free "summary" of
 *     an input string (truncate to N chars, append a trailing word
 *     count). The point is to demonstrate Gateway → Lambda dispatch,
 *     not to be useful — the smoke test asserts a stable shape.
 *
 * Gateway invocation contract (validated live, 2026-05-27):
 *   - `event` is the tool's input arguments map (no envelope).
 *   - `context.clientContext.custom.bedrockAgentCoreToolName` is the
 *     full namespaced tool name in the form `${target_name}___${tool_name}`,
 *     e.g. `tools___getCurrentTime`. Note: TRIPLE underscore (the
 *     older docs page implies single — that's wrong on the current
 *     service). We strip the configured target prefix and dispatch
 *     on the bare tool name.
 *   - Return any JSON; the gateway forwards it as the tool result.
 */

const TARGET_NAME = process.env['GATEWAY_TARGET_NAME'] ?? 'tools';
/**
 * AgentCore Gateway uses a triple-underscore delimiter between
 * target name and tool name on the wire (e.g. `tools___getCurrentTime`),
 * NOT the single-underscore the older docs imply.
 */
const DELIMITER = '___';

/** Strip the AgentCore Gateway target-name prefix from a tool name. */
function stripPrefix(toolName) {
    const prefix = `${TARGET_NAME}${DELIMITER}`;
    return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}

/** getCurrentTime — return the current time, optionally in a timezone. */
function getCurrentTime(args) {
    const now = new Date();
    const timezone = typeof args?.timezone === 'string' ? args.timezone : 'UTC';
    let formatted;
    try {
        formatted = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            dateStyle: 'short',
            timeStyle: 'long',
        }).format(now);
    } catch {
        // Bad IANA name — fall back to UTC ISO so the tool always succeeds.
        return {
            iso: now.toISOString(),
            timezone: 'UTC',
            formatted: now.toUTCString(),
            note: `unknown timezone "${timezone}"; returned UTC instead`,
        };
    }
    return {
        iso: now.toISOString(),
        timezone,
        formatted,
    };
}

/** summarizeText — deterministic mock summary (no model, no network). */
function summarizeText(args) {
    const text = typeof args?.text === 'string' ? args.text : '';
    const maxChars = typeof args?.maxChars === 'number' && args.maxChars > 0 ? args.maxChars : 80;
    const trimmed = text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
    const wordCount = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
    return {
        summary: trimmed,
        wordCount,
        truncated: text.length > maxChars,
    };
}

/** Lambda entry point invoked by the AgentCore Gateway. */
export const handler = async (event, context) => {
    // AgentCore Gateway passes its metadata via Lambda's clientContext
    // mechanism. Live invocations show the keys live under
    // `context.clientContext.custom` (lower-camel), but accept the
    // upper-camel `Custom` form too in case the runtime changes.
    const cc = context?.clientContext ?? {};
    const custom = cc.custom ?? cc.Custom ?? {};
    const fullName = custom.bedrockAgentCoreToolName ?? '';
    const toolName = stripPrefix(fullName);
    switch (toolName) {
        case 'getCurrentTime':
            return getCurrentTime(event);
        case 'summarizeText':
            return summarizeText(event);
        default:
            return {
                error: 'unknown_tool',
                message: `Tool "${fullName}" is not implemented by this Lambda.`,
            };
    }
};
