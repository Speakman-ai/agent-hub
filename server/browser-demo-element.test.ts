import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DOC_TOKEN_SCRIPT,
  describeElementScript,
  pageReadScript,
  parsePageRead,
  parseDemoElementDescription,
  parseDocToken,
} from './browser-demo-element.js';

/**
 * `jsdom` is declared by the repo root and by `client`, not by `server`, so it
 * resolves through node's upward walk (no `@types/jsdom` here either).
 */
interface JsdomWindow {
  document: Document;
  eval: (src: string) => unknown;
}
interface JsdomModule {
  JSDOM: new (html: string, opts: { runScripts: 'outside-only' }) => { window: JsdomWindow };
}
let jsdom: JsdomModule | null = null;
try {
  jsdom = createRequire(import.meta.url)('jsdom') as JsdomModule;
} catch {
  jsdom = null;
}

let win: JsdomWindow;
let document: Document;

function load(html: string): void {
  win = new jsdom!.JSDOM(`<!doctype html><body>${html}</body>`, {
    runScripts: 'outside-only',
  }).window;
  document = win.document;
}

/** Run the script the way page.evaluate() does: inside the page's realm. */
function run(point: { x: number; y: number } | null): unknown {
  return JSON.parse(JSON.stringify(win.eval(describeElementScript(point))));
}

function stubPoint(el: Element | null): void {
  (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => el;
}

const describeDom = jsdom ? describe : describe.skip;

beforeEach(() => {
  if (jsdom) load('');
});

describeDom('describeElementScript (in-page)', () => {
  it('describes a click on an icon inside a button by the button', () => {
    load('<div><button data-testid="save-btn"><span id="icon">*</span> Save draft</button></div>');
    stubPoint(document.getElementById('icon'));
    expect(run({ x: 10, y: 10 })).toEqual({
      selector: 'button[data-testid="save-btn"]',
      text: '* Save draft',
      tag: 'button',
      // Not a text-entry control, so keystrokes into it would be masked.
      sensitive: true,
    });
  });

  it('prefers a unique id and falls back to an nth-of-type path', () => {
    load('<ul><li>One</li><li>Two</li></ul><a id="go" href="#">Go</a>');
    stubPoint(document.querySelectorAll('li')[1]);
    const li = run({ x: 1, y: 1 }) as { selector: string; text: string };
    expect(document.querySelectorAll(li.selector)).toHaveLength(1);
    expect(document.querySelector(li.selector)?.textContent).toBe('Two');
    stubPoint(document.getElementById('go'));
    expect(run({ x: 1, y: 1 })).toMatchObject({ selector: '#go', text: 'Go', tag: 'a' });
  });

  it('labels a focused text input without reading its value', () => {
    load(
      '<label for="email">Email address</label><input id="email" name="email" value="me@x.com">',
    );
    document.getElementById('email')!.focus();
    const d = run(null) as Record<string, unknown>;
    expect(d).toEqual({
      selector: '#email',
      text: 'Email address',
      tag: 'input',
      sensitive: false,
    });
    expect(JSON.stringify(d)).not.toContain('me@x.com');
  });

  it('flags password, one-time-code and card fields as sensitive', () => {
    load(
      '<input id="pw" type="password"><input id="otp" autocomplete="one-time-code"><input id="cc" autocomplete="cc-number">',
    );
    for (const id of ['pw', 'otp', 'cc']) {
      document.getElementById(id)!.focus();
      expect(run(null)).toMatchObject({ sensitive: true });
    }
  });

  it('treats focus inside a frame, or no focus, as sensitive', () => {
    load('<iframe id="pay"></iframe>');
    document.getElementById('pay')!.focus();
    expect(run(null)).toMatchObject({ tag: 'iframe', sensitive: true });
    (document.activeElement as HTMLElement | null)?.blur();
    expect(run(null)).toMatchObject({ selector: null, sensitive: true });
  });

  it('masks focus inside a closed shadow root (the host hides the real field)', () => {
    load('<login-box id="box"></login-box>');
    const host = document.getElementById('box')!;
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<input id="pw" type="password">';
    (root.getElementById('pw') as HTMLInputElement).focus();
    expect(document.activeElement).toBe(host);
    expect(host.shadowRoot).toBeNull();
    expect(run(null)).toMatchObject({ tag: 'login-box', sensitive: true });
  });

  it('follows open shadow roots to the focused field', () => {
    load('<search-box id="sb"></search-box>');
    const root = document.getElementById('sb')!.attachShadow({ mode: 'open' });
    root.innerHTML = '<input id="q" type="search" placeholder="Search">';
    (root.getElementById('q') as HTMLInputElement).focus();
    expect(run(null)).toMatchObject({ tag: 'input', text: 'Search', sensitive: false });
  });

  it('keeps shadow-host identity so similar controls in different hosts stay distinct', () => {
    load('<form><email-field></email-field><email-field></email-field></form>');
    const hosts = Array.from(document.querySelectorAll('email-field'));
    const inner = hosts.map((h, n) => {
      const root = h.attachShadow({ mode: 'open' });
      root.innerHTML = `<label>Email</label><input id="in-${n}" type="email">`;
      return root.querySelector('input') as HTMLInputElement;
    });
    const sel = inner.map((el) => {
      el.focus();
      return (run(null) as { selector: string }).selector;
    });
    expect(sel[0]).not.toBe(sel[1]);
    // Each segment resolves inside its own root to exactly the focused control.
    sel.forEach((full, n) => {
      const [hostSel, innerSel] = full.split(' >> ');
      const host = document.querySelectorAll(hostSel);
      expect(host).toHaveLength(1);
      expect(host[0]).toBe(hosts[n]);
      expect(host[0].shadowRoot!.querySelector(innerSel)).toBe(inner[n]);
    });
    // Clicks resolve through the same chain.
    stubPoint(hosts[1]);
    (hosts[1].shadowRoot as unknown as { elementFromPoint: () => Element }).elementFromPoint = () =>
      inner[1];
    expect((run({ x: 1, y: 1 }) as { selector: string }).selector).toBe(sel[1]);
  });

  it('disambiguates identical inner ids through the host chain', () => {
    load('<div id="a"><x-box></x-box></div><div id="b"><x-box></x-box></div>');
    const inputs = Array.from(document.querySelectorAll('x-box')).map((h) => {
      const root = h.attachShadow({ mode: 'open' });
      root.innerHTML = '<input id="field" type="text">';
      return root.getElementById('field') as HTMLInputElement;
    });
    const sel = inputs.map((el) => {
      el.focus();
      return (run(null) as { selector: string }).selector;
    });
    expect(sel).toEqual(['#a > x-box >> #field', '#b > x-box >> #field']);
  });

  it('stores text only for known plain text-entry controls', () => {
    load(
      '<textarea id="ta"></textarea><input id="s" type="search"><div id="ce" contenteditable="true" tabindex="0">x</div>' +
        '<div id="custom" tabindex="0">widget</div><input id="d" type="date">',
    );
    const sensitivity = (id: string) => {
      (document.getElementById(id) as HTMLElement).focus();
      return (run(null) as { sensitive: boolean }).sensitive;
    };
    expect(['ta', 's', 'ce'].map(sensitivity)).toEqual([false, false, false]);
    expect(['custom', 'd'].map(sensitivity)).toEqual([true, true]);
  });

  it('never labels a click on an editable region with its content', () => {
    load(
      '<div id="ed" contenteditable="true" aria-label="Note"><p id="para">my secret draft</p></div>',
    );
    stubPoint(document.getElementById('para'));
    const d = run({ x: 1, y: 1 });
    expect(JSON.stringify(d)).not.toContain('secret draft');
    stubPoint(document.getElementById('ed'));
    expect(run({ x: 1, y: 1 })).toMatchObject({ text: 'Note' });
  });

  it('masks plain inputs whose name, id or label marks them as secret', () => {
    load(
      '<input id="a" name="user_pin"><input id="mfa-code"><input id="c" aria-label="Card number"><input id="spinner-count">',
    );
    const sensitivity = (id: string) => {
      (document.getElementById(id) as HTMLElement).focus();
      return (run(null) as { sensitive: boolean }).sensitive;
    };
    expect(['a', 'mfa-code', 'c'].map(sensitivity)).toEqual([true, true, true]);
    expect(sensitivity('spinner-count')).toBe(false);
  });

  it('truncates long labels without splitting a surrogate pair', () => {
    load(`<button id="b">${'a'.repeat(78)}😀x</button>`);
    stubPoint(document.getElementById('b'));
    const text = (run({ x: 1, y: 1 }) as { text: string }).text;
    expect(text).toBe('a'.repeat(78) + '…');
  });

  it('document token is stable within a document, new per document, and not a string key', () => {
    const first = parseDocToken(win.eval(DOC_TOKEN_SCRIPT));
    expect(first).toBeTruthy();
    expect(parseDocToken(win.eval(DOC_TOKEN_SCRIPT))).toBe(first);
    expect(Object.keys(win)).not.toContain('agent-hub.demo.document');
    load('');
    expect(parseDocToken(win.eval(DOC_TOKEN_SCRIPT))).not.toBe(first);
  });

  it('one page read returns the document token and the target together', () => {
    load('<input id="q" type="search" placeholder="Search">');
    document.getElementById('q')!.focus();
    const token = parseDocToken(win.eval(DOC_TOKEN_SCRIPT));
    const read = parsePageRead(
      JSON.parse(JSON.stringify(win.eval(pageReadScript({ kind: 'focus' })))),
    );
    expect(read).toEqual({
      doc: token,
      target: { selector: '#q', text: 'Search', tag: 'input', sensitive: false },
    });
    const none = parsePageRead(
      JSON.parse(JSON.stringify(win.eval(pageReadScript({ kind: 'none' })))),
    );
    expect(none).toEqual({ doc: token, target: null });
    expect(parsePageRead('garbage')).toEqual({ doc: null, target: null });
  });
});

describe('parseDemoElementDescription', () => {
  it('caps strings on a code-point boundary', () => {
    const d = parseDemoElementDescription({ text: 'a'.repeat(79) + '😀', sensitive: false });
    expect(d?.text).toBe('a'.repeat(79));
  });

  it('defaults to sensitive when the page returns something malformed', () => {
    expect(parseDemoElementDescription(null)).toBeNull();
    expect(parseDemoElementDescription({ selector: '#a' })).toEqual({
      selector: '#a',
      text: null,
      tag: null,
      sensitive: true,
    });
  });
});
