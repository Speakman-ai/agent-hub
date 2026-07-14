import { describe, expect, it } from 'vitest';
import {
  createXtermTerminalBuffer,
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  FakeTerminalBuffer,
} from './terminal-buffer.js';

describe('FakeTerminalBuffer', () => {
  it('replays written data verbatim on serialize', () => {
    const buf = new FakeTerminalBuffer();
    buf.write('hello ');
    buf.write('world');
    expect(buf.serialize()).toBe('hello world');
  });

  it('tracks resize and starts at the terminal defaults', () => {
    const buf = new FakeTerminalBuffer();
    expect(buf.cols).toBe(DEFAULT_TERMINAL_COLS);
    expect(buf.rows).toBe(DEFAULT_TERMINAL_ROWS);
    buf.resize(120, 40);
    expect(buf.cols).toBe(120);
    expect(buf.rows).toBe(40);
  });

  it('flush resolves and dispose clears state', async () => {
    const buf = new FakeTerminalBuffer({ cols: 100, rows: 30 });
    buf.write('data');
    await expect(buf.flush()).resolves.toBeUndefined();
    buf.dispose();
    expect(buf.disposed).toBe(true);
    expect(buf.serialize()).toBe('');
  });
});

describe('createXtermTerminalBuffer (real headless xterm)', () => {
  it('parses PTY output into scrollback and round-trips it through serialize', async () => {
    const buf = await createXtermTerminalBuffer({ cols: 80, rows: 24, scrollback: 1000 });
    try {
      buf.write('first line\r\nsecond line\r\n');
      await buf.flush();
      const snapshot = buf.serialize();
      expect(snapshot).toContain('first line');
      expect(snapshot).toContain('second line');
    } finally {
      buf.dispose();
    }
  });

  it('resizes without throwing and keeps prior content', async () => {
    const buf = await createXtermTerminalBuffer({ cols: 80, rows: 24 });
    try {
      buf.write('keep me\r\n');
      await buf.flush();
      buf.resize(120, 40);
      await buf.flush();
      expect(buf.serialize()).toContain('keep me');
    } finally {
      buf.dispose();
    }
  });
});
