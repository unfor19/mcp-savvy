/**
 * Stderr logger.
 *
 * MCP servers communicate over stdio with JSON-RPC; stdout is reserved
 * for protocol messages. Everything diagnostic must go to stderr or it
 * corrupts the channel and the host disconnects.
 *
 * Reference projects all use ad-hoc `console.error` / `print(file=sys.stderr)`.
 * We standardize on a small Logger interface so we can route to JSON
 * when `MCP_SAVVY_LOG=json` is set.
 */

/** Logger severity levels in increasing order. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Stderr-only logger interface. Stdout is reserved for MCP JSON-RPC. */
export interface Logger {
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
    child(fields: Record<string, unknown>): Logger;
}

/** Options for `createLogger`. */
export interface LoggerOptions {
    /** Logger name shown in text output and emitted as `name` in JSON. */
    name?: string;
    /** Minimum level to emit. Defaults to `info`. */
    level?: LogLevel;
    /** `text` (default) or `json`. */
    format?: 'text' | 'json';
    /** Bound fields included on every line. */
    fields?: Record<string, unknown>;
}

const LEVEL_RANK: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

class StderrLogger implements Logger {
    private readonly name: string;
    private readonly level: LogLevel;
    private readonly format: 'text' | 'json';
    private readonly fields: Record<string, unknown>;

    constructor(opts: LoggerOptions) {
        this.name = opts.name ?? 'mcp-savvy';
        this.level = opts.level ?? 'info';
        this.format = opts.format ?? 'text';
        this.fields = opts.fields ?? {};
    }

    private emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
        if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;

        const merged = { ...this.fields, ...(fields ?? {}) };

        if (this.format === 'json') {
            const record = {
                ts: new Date().toISOString(),
                level,
                name: this.name,
                msg: message,
                ...merged,
            };
            process.stderr.write(JSON.stringify(record) + '\n');
            return;
        }

        const tag = `[${this.name}]`;
        const lvl = level.toUpperCase().padEnd(5);
        const extras = Object.keys(merged).length > 0 ? ' ' + JSON.stringify(merged) : '';
        process.stderr.write(`${tag} ${lvl} ${message}${extras}\n`);
    }

    debug(message: string, fields?: Record<string, unknown>): void {
        this.emit('debug', message, fields);
    }
    info(message: string, fields?: Record<string, unknown>): void {
        this.emit('info', message, fields);
    }
    warn(message: string, fields?: Record<string, unknown>): void {
        this.emit('warn', message, fields);
    }
    error(message: string, fields?: Record<string, unknown>): void {
        this.emit('error', message, fields);
    }

    child(fields: Record<string, unknown>): Logger {
        return new StderrLogger({
            name: this.name,
            level: this.level,
            format: this.format,
            fields: { ...this.fields, ...fields },
        });
    }
}

/**
 * Build a logger. Reads `MCP_SAVVY_DEBUG` and `MCP_SAVVY_LOG` from
 * `process.env` so the CLI doesn't need to wire those flags through
 * every package.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
    const envLevel = process.env.MCP_SAVVY_DEBUG === '1' ? 'debug' : undefined;
    const envFormat = process.env.MCP_SAVVY_LOG === 'json' ? 'json' : undefined;
    return new StderrLogger({
        ...opts,
        level: opts.level ?? envLevel ?? 'info',
        format: opts.format ?? envFormat ?? 'text',
    });
}
