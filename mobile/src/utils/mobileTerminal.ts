/**
 * The React Native ↔ terminal WebView contract.
 *
 * The WebView is the xterm renderer. React Native owns the authenticated
 * terminal WebSocket and forwards server frames into the WebView with
 * `injectJavaScript`; xterm input and resize events travel back through
 * `window.ReactNativeWebView.postMessage`.
 */

import { XTERM_CSS, XTERM_JS } from './xtermBundle.generated';

export const TERMINAL_BRIDGE_CHANNEL = 'ah-terminal';
export const XTERM_VERSION = '6.0.0';
export const TERMINAL_OUTPUT_BATCH_DELAY_MS = 16;
export const TERMINAL_OUTPUT_BATCH_MAX_CHUNKS = 32;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Encode terminal input without relying on browser-only globals. Hermes and
 * older React Native runtimes do not consistently expose TextEncoder/btoa,
 * while the special-key bar still needs the server's UTF-8 base64 wire form.
 */
export function encodeTerminalInputBase64(value: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
        index += 1;
      } else {
        codePoint = 0xfffd;
      }
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      codePoint = 0xfffd;
    }
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }

  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += BASE64_ALPHABET[first >> 2];
    encoded += BASE64_ALPHABET[((first & 0x03) << 4) | (second === undefined ? 0 : second >> 4)];
    encoded += second === undefined ? '=' : BASE64_ALPHABET[((second & 0x0f) << 2) | (third === undefined ? 0 : third >> 6)];
    encoded += third === undefined ? '=' : BASE64_ALPHABET[third & 0x3f];
  }
  return encoded;
}

export type TerminalBridgeMessage = {
  ch: typeof TERMINAL_BRIDGE_CHANNEL;
  type: 'ready' | 'input' | 'resize' | 'error';
  encoding?: 'base64';
  data?: string;
  cols?: number;
  rows?: number;
  message?: string;
};

/** Parse and validate an inbound WebView message without trusting its shape. */
export function parseTerminalBridgeMessage(raw: unknown): TerminalBridgeMessage | null {
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const message = parsed as Record<string, unknown>;
  if (message.ch !== TERMINAL_BRIDGE_CHANNEL || typeof message.type !== 'string') return null;
  if (!['ready', 'input', 'resize', 'error'].includes(message.type)) return null;
  if (message.type === 'input') {
    if (message.encoding !== 'base64' || typeof message.data !== 'string') return null;
  }
  if (message.type === 'resize') {
    if (
      !Number.isInteger(message.cols) ||
      !Number.isInteger(message.rows) ||
      Number(message.cols) < 1 ||
      Number(message.rows) < 1
    ) {
      return null;
    }
  }
  return message as TerminalBridgeMessage;
}

/**
 * Coalesce PTY output before crossing the native/WebView bridge. The bridge
 * has substantially more overhead than an in-page xterm write, so one native
 * callback per PTY chunk can make a busy shell visibly lag.
 */
export class TerminalOutputBatcher {
  #chunks: string[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #flush: (chunks: string[]) => void;
  #delayMs: number;
  #maxChunks: number;

  constructor(
    flush: (chunks: string[]) => void,
    options: { delayMs?: number; maxChunks?: number } = {},
  ) {
    this.#flush = flush;
    this.#delayMs = options.delayMs ?? TERMINAL_OUTPUT_BATCH_DELAY_MS;
    this.#maxChunks = options.maxChunks ?? TERMINAL_OUTPUT_BATCH_MAX_CHUNKS;
  }

  push(chunk: string): void {
    if (!chunk) return;
    this.#chunks.push(chunk);
    if (this.#chunks.length >= this.#maxChunks) {
      this.flushNow();
      return;
    }
    if (this.#timer === null) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.flushNow();
      }, this.#delayMs);
    }
  }

  flushNow(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (!this.#chunks.length) return;
    const chunks = this.#chunks;
    this.#chunks = [];
    this.#flush(chunks);
  }

  dispose(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#chunks = [];
  }
}

/** Build the JavaScript call used for RN → WebView frame delivery. */
export function buildTerminalReceiveScript(frame: Record<string, unknown>): string {
  return `window.__ahTerminalReceive(${JSON.stringify(frame)}); true;`;
}

/**
 * Build a self-contained xterm document. The renderer and CSS are generated
 * from the installed @xterm/xterm package and checked into the app bundle;
 * the WebView makes no runtime request for executable renderer code.
 * The React Native WebView bridge remains the only application integration;
 * the page never receives credentials or accesses Hub storage.
 */
export function buildTerminalHtml(): string {
  return `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>${XTERM_CSS}
html,body,#terminal{width:100%;height:100%;margin:0;overflow:hidden;background:#030712}#terminal{padding:8px;box-sizing:border-box}</style>
</head><body><div id="terminal"></div>
<script>${XTERM_JS}</script>
<script>
(function () {
  var CH = ${JSON.stringify(TERMINAL_BRIDGE_CHANNEL)};
  var terminal = null;
  var attached = false;
  function post(message) {
    try {
      if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
        window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({ ch: CH }, message)));
      }
    } catch (_) {}
  }
  function encode(value) {
    var bytes = new TextEncoder().encode(value);
    var binary = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }
  function decode(value) {
    var binary = atob(value || '');
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function dimensions() {
    return { cols: Math.max(1, terminal && terminal.cols || 80), rows: Math.max(1, terminal && terminal.rows || 24) };
  }
  function fitToViewport() {
    if (!terminal) return dimensions();
    var host = document.getElementById('terminal');
    if (!host) return dimensions();
    var sample = document.createElement('span');
    var styleSource = host.querySelector('.xterm-rows') || terminal.element || host;
    var computed = window.getComputedStyle(styleSource);
    sample.textContent = 'W';
    sample.style.position = 'absolute';
    sample.style.visibility = 'hidden';
    sample.style.display = 'inline-block';
    sample.style.fontFamily = computed.fontFamily;
    sample.style.fontSize = computed.fontSize;
    sample.style.lineHeight = computed.lineHeight;
    host.appendChild(sample);
    var rect = sample.getBoundingClientRect();
    host.removeChild(sample);
    var cellWidth = rect.width || 8;
    var cellHeight = rect.height || 16;
    var contentWidth = Math.max(1, host.clientWidth - 16);
    var contentHeight = Math.max(1, host.clientHeight - 16);
    var cols = Math.max(1, Math.floor(contentWidth / cellWidth));
    var rows = Math.max(1, Math.floor(contentHeight / cellHeight));
    if (cols !== terminal.cols || rows !== terminal.rows) terminal.resize(cols, rows);
    return dimensions();
  }
  function setup() {
    if (terminal) return;
    var TerminalCtor = window.Terminal;
    if (typeof TerminalCtor !== 'function') {
      post({ type: 'error', message: 'The xterm renderer failed to load' });
      return;
    }
    terminal = new TerminalCtor({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: { background: '#030712', foreground: '#e5e7eb', cursor: '#67e8f9', selectionBackground: '#164e63' }
    });
    var host = document.getElementById('terminal');
    terminal.open(host);
    terminal.onData(function (data) {
      post({ type: 'input', encoding: 'base64', data: encode(data) });
    });
    terminal.onResize(function (size) {
      post({ type: 'resize', cols: size.cols, rows: size.rows });
    });
    var resizeViewport = function () { fitToViewport(); };
    window.addEventListener('resize', resizeViewport);
    if (typeof ResizeObserver === 'function') {
      var resizeObserver = new ResizeObserver(resizeViewport);
      resizeObserver.observe(host);
    }
    terminal.focus();
    var announceReady = function () { post(Object.assign({ type: 'ready' }, fitToViewport())); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(announceReady); else announceReady();
  }
  window.__ahTerminalReceive = function (frame) {
    if (!terminal || !frame || typeof frame.type !== 'string') return;
    try {
      if (frame.type === 'attached' && frame.encoding === 'base64') {
        terminal.reset();
        terminal.write(decode(frame.data));
        attached = true;
        terminal.focus();
      } else if (frame.type === 'output' && frame.encoding === 'base64') {
        terminal.write(decode(frame.data));
      } else if (frame.type === 'output_batch' && Array.isArray(frame.data)) {
        for (var i = 0; i < frame.data.length; i += 1) terminal.write(decode(frame.data[i]));
      } else if (frame.type === 'detached') {
        attached = false;
      } else if (frame.type === 'exit') {
        attached = false;
        terminal.writeln('\\r\\n[terminal exited with code ' + frame.exitCode + ']');
      } else if (frame.type === 'error') {
        attached = false;
        post({ type: 'error', message: frame.message || 'Terminal connection failed' });
      }
    } catch (_) {
      attached = false;
      post({ type: 'error', message: 'The terminal server sent invalid terminal data' });
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup); else setup();
}());
</script></body></html>`;
}
