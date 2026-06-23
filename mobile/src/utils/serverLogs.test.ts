// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { formatServerLogLine } from './serverLogs';
describe('formatServerLogLine', () => {
    it('formats a full LogEntry as "HH:MM:SS LEVEL  message"', () => {
        expect(formatServerLogLine({
            ts: '2026-06-17T20:55:07.123Z',
            level: 'warn',
            message: 'something happened',
        })).toBe('20:55:07 WARN  something happened');
    });
    it('omits the time prefix when ts is missing or malformed', () => {
        expect(formatServerLogLine({ level: 'error', message: 'boom' })).toBe('ERROR  boom');
        expect(formatServerLogLine({ ts: 'nope', level: 'log', message: 'hi' })).toBe('LOG  hi');
    });
    it('falls back to legacy line / text fields for the message', () => {
        expect(formatServerLogLine({ level: 'log', line: 'from line' })).toBe('LOG  from line');
        expect(formatServerLogLine({ text: 'from text' })).toBe('from text');
    });
    it('passes raw strings through unchanged', () => {
        expect(formatServerLogLine('already a line')).toBe('already a line');
    });
    it('never throws on null / undefined / empty input', () => {
        expect(formatServerLogLine(null)).toBe('');
        expect(formatServerLogLine(undefined)).toBe('');
        expect(formatServerLogLine({})).toBe('');
    });
});
