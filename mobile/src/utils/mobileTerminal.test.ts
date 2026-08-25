import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTerminalHtml,
  buildTerminalReceiveScript,
  encodeTerminalInputBase64,
  parseTerminalBridgeMessage,
  TERMINAL_BRIDGE_CHANNEL,
  TerminalOutputBatcher,
} from './mobileTerminal';

describe('mobile terminal WebView bridge', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('accepts only channel-tagged input and resize messages', () => {
    expect(
      parseTerminalBridgeMessage(
        JSON.stringify({ ch: TERMINAL_BRIDGE_CHANNEL, type: 'ready', cols: 80, rows: 24 }),
      ),
    ).toMatchObject({ ch: TERMINAL_BRIDGE_CHANNEL, type: 'ready', cols: 80, rows: 24 });
    expect(
      parseTerminalBridgeMessage({
        ch: TERMINAL_BRIDGE_CHANNEL,
        type: 'input',
        encoding: 'base64',
        data: 'YWJj',
      }),
    ).toMatchObject({ type: 'input', data: 'YWJj' });
    expect(
      parseTerminalBridgeMessage({
        ch: TERMINAL_BRIDGE_CHANNEL,
        type: 'resize',
        cols: 120,
        rows: 40,
      }),
    ).toMatchObject({ type: 'resize', cols: 120, rows: 40 });
    expect(parseTerminalBridgeMessage({ ch: 'other', type: 'ready' })).toBeNull();
    expect(
      parseTerminalBridgeMessage({ ch: TERMINAL_BRIDGE_CHANNEL, type: 'input', data: 'bad' }),
    ).toBeNull();
    expect(
      parseTerminalBridgeMessage({
        ch: TERMINAL_BRIDGE_CHANNEL,
        type: 'resize',
        cols: 0,
        rows: 20,
      }),
    ).toBeNull();
  });

  it('encodes special-key and Unicode input without TextEncoder or btoa', () => {
    vi.stubGlobal('TextEncoder', undefined);
    vi.stubGlobal('btoa', undefined);
    expect(encodeTerminalInputBase64('\u0003')).toBe('Aw==');
    expect(encodeTerminalInputBase64('echo ✓')).toBe('ZWNobyDinJM=');
    expect(encodeTerminalInputBase64('😀')).toBe('8J+YgA==');
  });

  it('builds a WebView document that uses xterm and the RN postMessage contract', () => {
    const html = buildTerminalHtml();
    expect(html).toContain('xterm-accessibility');
    expect(html).not.toContain('cdn.jsdelivr.net');
    expect(html).not.toContain('<script src=');
    expect(html).toContain('window.ReactNativeWebView.postMessage');
    expect(html).toContain('window.__ahTerminalReceive');
    expect(html).toContain("type: 'ready'");
    expect(html).toContain("type === 'output_batch'");
    expect(html).toContain('terminal.reset()');
    expect(html).toContain('getBoundingClientRect');
    expect(html).toContain('ResizeObserver');
    expect(html).toContain('requestAnimationFrame(announceReady)');
  });

  it('keeps the inline WebView controller valid JavaScript', () => {
    const html = buildTerminalHtml();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    expect(scripts).toHaveLength(2);
    expect(() => new Function(scripts[0])).not.toThrow();
    expect(() => new Function(scripts[1])).not.toThrow();
  });

  it('serializes native-to-WebView frames as one executable bridge call', () => {
    const script = buildTerminalReceiveScript({ type: 'error', message: "bad 'frame'" });
    expect(script).toContain('window.__ahTerminalReceive(');
    expect(script).toContain("bad 'frame'");
    expect(script.endsWith('true;')).toBe(true);
  });

  it('batches output on a short timer and flushes immediately at the chunk cap', () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const batcher = new TerminalOutputBatcher(flush, { delayMs: 20, maxChunks: 3 });

    batcher.push('one');
    batcher.push('two');
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(19);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledWith(['one', 'two']);

    batcher.push('a');
    batcher.push('b');
    batcher.push('c');
    expect(flush).toHaveBeenLastCalledWith(['a', 'b', 'c']);
    batcher.dispose();
  });
});
