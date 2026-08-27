/**
 * Unit tests for the stderr logger.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createLogger } from './logger.js';

let stderrSpy: ReturnType<typeof vi.spyOn>;
let captured: string[] = [];

beforeEach(() => {
    captured = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
    });
});

afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env.MCP_SAVVY_DEBUG;
    delete process.env.MCP_SAVVY_LOG;
});

describe('text format', () => {
    it('writes a single line per call with the level + name + message', () => {
        const log = createLogger({ name: 'test-logger', level: 'info' });
        log.info('hello world');
        expect(captured).toHaveLength(1);
        const line = captured[0]!;
        expect(line).toContain('[test-logger]');
        expect(line).toContain('INFO');
        expect(line).toContain('hello world');
        expect(line.endsWith('\n')).toBe(true);
    });

    it('appends fields as JSON when present', () => {
        const log = createLogger({ name: 'x', level: 'debug' });
        log.debug('msg', { foo: 1, bar: 'b' });
        const line = captured[0]!;
        expect(line).toMatch(/\{"foo":1,"bar":"b"\}/);
    });

    it('drops messages below the configured level', () => {
        const log = createLogger({ level: 'warn' });
        log.debug('drop');
        log.info('drop');
        log.warn('keep');
        log.error('keep');
        expect(captured).toHaveLength(2);
        expect(captured[0]).toContain('WARN');
        expect(captured[1]).toContain('ERROR');
    });
});

describe('json format', () => {
    it('emits one JSON object per line with timestamp, level, name, msg', () => {
        const log = createLogger({ name: 'jsonlog', format: 'json', level: 'info' });
        log.info('boot', { phase: 'init' });
        const line = captured[0]!.trim();
        const record = JSON.parse(line);
        expect(record.level).toBe('info');
        expect(record.name).toBe('jsonlog');
        expect(record.msg).toBe('boot');
        expect(record.phase).toBe('init');
        expect(typeof record.ts).toBe('string');
    });
});

describe('child loggers', () => {
    it('inherits and merges fields', () => {
        const log = createLogger({ name: 'p', format: 'json', level: 'debug' });
        const child = log.child({ requestId: 'r1' });
        child.info('done', { extra: true });
        const record = JSON.parse(captured[0]!.trim());
        expect(record.requestId).toBe('r1');
        expect(record.extra).toBe(true);
    });
});

describe('defaults', () => {
    it('uses sensible defaults when no options are passed', () => {
        const log = createLogger();
        log.info('default config');
        expect(captured).toHaveLength(1);
        expect(captured[0]).toContain('[mcp-savvy]');
        expect(captured[0]).toContain('INFO');
    });

    it('the bound-fields default is treated as empty', () => {
        const log = createLogger({ name: 'p', format: 'json', level: 'info' });
        log.info('msg');
        const record = JSON.parse(captured[0]!.trim());
        // No surprise extra keys beyond ts/level/name/msg.
        expect(Object.keys(record).sort()).toEqual(['level', 'msg', 'name', 'ts']);
    });
});

describe('env-var overrides', () => {
    it('MCP_SAVVY_DEBUG=1 lowers level to debug', () => {
        process.env.MCP_SAVVY_DEBUG = '1';
        const log = createLogger();
        log.debug('show me');
        expect(captured).toHaveLength(1);
    });

    it('MCP_SAVVY_LOG=json switches to JSON format', () => {
        process.env.MCP_SAVVY_LOG = 'json';
        const log = createLogger({ level: 'info' });
        log.info('hi');
        expect(() => JSON.parse(captured[0]!.trim())).not.toThrow();
    });

    it('explicit options beat env vars', () => {
        process.env.MCP_SAVVY_LOG = 'json';
        const log = createLogger({ level: 'info', format: 'text' });
        log.info('hi');
        expect(captured[0]).toContain('INFO');
        expect(() => JSON.parse(captured[0]!.trim())).toThrow();
    });
});
