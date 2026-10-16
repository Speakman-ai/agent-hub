import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BrowserDemoRecorder,
  DEMO_MASKED_TEXT,
  DEMO_RECORDING_MAX_MS,
  DEMO_TYPED_TEXT_MAX_CHARS,
  demoRecordingFilename,
  type DemoPageLike,
  type DemoRecording,
  type DemoViewerInput,
} from './browser-demo-recorder.js';
import { PAGE_READ_MARKER, type DemoElementDescription } from './browser-demo-element.js';

const SID = 'chat-1';

/**
 * Fake page: `evaluate` answers the describer with whatever is under the
 * pointer (point scripts) or focused (`null` scripts).
 */
function fakePage(state: {
  url: string;
  at?: DemoElementDescription;
  focused?: DemoElementDescription | null;
  /** Document token; change it to simulate a new document at the same URL. */
  doc?: string;
}): DemoPageLike & {
  describe: ReturnType<typeof vi.fn<(script: string) => Promise<unknown>>>;
  evaluate: ReturnType<typeof vi.fn<(script: string) => Promise<unknown>>>;
} {
  // Every page read returns {doc, target} together, like the real script.
  // The target half goes to `describe` (tests override and count it; focus
  // reads end in '(null)'), and the document token comes from `state.doc`.
  const describe = vi.fn(async (script: string) =>
    script.endsWith('(null)') ? (state.focused ?? null) : (state.at ?? null),
  );
  return {
    url: () => state.url,
    describe,
    evaluate: vi.fn(async (script: string) => {
      const mode = script.slice(PAGE_READ_MARKER.length, script.indexOf('*/'));
      const doc = state.doc ?? 'doc-1';
      if (mode === 'none') return { doc, target: null };
      const target = await describe(mode === 'focus' ? 'describe(null)' : 'describe(point)');
      return { doc, target };
    }),
  };
}

const field = (selector: string, text: string, sensitive = false): DemoElementDescription => ({
  selector,
  text,
  tag: 'input',
  sensitive,
});

describe('BrowserDemoRecorder', () => {
  let now: number;
  let url: string;
  let agentDriving: boolean;
  let saved: DemoRecording[];
  let rec: BrowserDemoRecorder;
  const ok = async (): Promise<{ ok: boolean }> => ({ ok: true });

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
    url = 'https://example.com/';
    agentDriving = false;
    saved = [];
    rec = new BrowserDemoRecorder({
      now: () => now,
      currentUrl: () => url,
      isAgentDriving: () => agentDriving,
      save: async (r) => {
        saved.push(r);
        return { id: 'art-1', filename: 'demo.json', url: '/a' };
      },
    });
  });

  afterEach(() => {
    rec.resetForTests();
    vi.useRealTimers();
  });

  async function input(
    page: DemoPageLike,
    i: DemoViewerInput,
    result: () => Promise<{ ok: boolean }> = ok,
  ) {
    now += 100;
    return rec.record(SID, i, () => page, result);
  }

  it('records clicks with selector and visible text, and coalesces typing per field', async () => {
    const state = {
      url,
      at: { selector: 'button#login', text: 'Sign in', tag: 'button', sensitive: false },
      focused: field('#email', 'Email'),
    };
    const page = fakePage(state);
    rec.start(SID);
    await input(page, { kind: 'mouse', type: 'down', x: 10.4, y: 20, button: 'left' });
    await input(page, { kind: 'mouse', type: 'up', x: 10, y: 20, button: 'left' });
    for (const ch of 'me@x.c') await input(page, { kind: 'key', type: 'press', key: ch });
    await input(page, { kind: 'key', type: 'press', key: 'Backspace' });
    await input(page, { kind: 'text', text: 'io' });
    await input(page, { kind: 'key', type: 'press', key: 'Enter' });
    await input(page, { kind: 'key', type: 'press', key: 'a', modifiers: { ctrl: true } });
    const out = await rec.stop(SID);

    expect(out?.steps).toEqual([
      expect.objectContaining({
        type: 'click',
        selector: 'button#login',
        text: 'Sign in',
        x: 10,
        y: 20,
        button: 'left',
        url: 'https://example.com/',
      }),
      expect.objectContaining({ type: 'type', selector: '#email', text: 'me@x.c', masked: false }),
      expect.objectContaining({ type: 'key', key: 'Backspace' }),
      expect.objectContaining({ type: 'type', selector: '#email', text: 'io', masked: false }),
      expect.objectContaining({ type: 'key', key: 'Enter' }),
      expect.objectContaining({ type: 'key', key: 'a', modifiers: ['Control'] }),
    ]);
    // Focus is read before and after each input that can carry a character:
    // 6 characters, "io", and Ctrl+A (Enter and Backspace carry none).
    const focusLookups = page.describe.mock.calls.filter(([s]) => String(s).endsWith('(null)'));
    expect(focusLookups).toHaveLength(16);
  });

  it('keeps every character of a long paste across continuation steps', async () => {
    const page = fakePage({ url, focused: field('#body', 'Message') });
    const pasted = Array.from({ length: 4_500 }, (_, n) => String.fromCharCode(97 + (n % 26))).join(
      '',
    );
    rec.start(SID);
    await input(page, { kind: 'text', text: pasted });
    const out = await rec.stop(SID);
    const steps = out!.steps as Array<{ type: string; text?: string; continued?: boolean }>;
    expect(steps.map((s) => [s.type, s.text?.length, s.continued ?? false])).toEqual([
      ['type', DEMO_TYPED_TEXT_MAX_CHARS, false],
      ['type', DEMO_TYPED_TEXT_MAX_CHARS, true],
      ['type', 500, true],
    ]);
    expect(steps.map((s) => s.text).join('')).toBe(pasted);
    expect(out?.truncated).toBe(false);
  });

  it('never edits recorded text: Backspace is kept as the key the human pressed', async () => {
    const state: { url: string; focused: DemoElementDescription | null } = {
      url,
      focused: field('#a', 'A'),
    };
    const page = fakePage(state);
    rec.start(SID);
    // A pasted emoji is two UTF-16 code units; the browser's Backspace removes both.
    await input(page, { kind: 'text', text: 'a😀' });
    await input(page, { kind: 'key', type: 'press', key: 'Backspace' });
    await input(page, { kind: 'text', text: 'b' });
    // Page script moves focus elsewhere; a later Backspace still edits nothing recorded.
    state.focused = field('#b', 'B');
    await input(page, { kind: 'key', type: 'press', key: 'Backspace' });
    const out = await rec.stop(SID);
    expect(
      out?.steps.map((s) => [s.type, 'text' in s ? s.text : 'key' in s ? s.key : null]),
    ).toEqual([
      ['type', 'a😀'],
      ['key', 'Backspace'],
      ['type', 'b'],
      ['key', 'Backspace'],
    ]);
  });

  it('splits long text on code-point boundaries, never inside a surrogate pair', async () => {
    const page = fakePage({ url, focused: field('#body', 'Message') });
    // An emoji straddles the per-step limit.
    const text = 'a'.repeat(DEMO_TYPED_TEXT_MAX_CHARS - 1) + '😀' + 'tail';
    rec.start(SID);
    await input(page, { kind: 'text', text });
    // And typing that runs past the limit into the existing step.
    await input(page, { kind: 'key', type: 'press', key: 'Tab' });
    await input(page, { kind: 'text', text: 'b'.repeat(DEMO_TYPED_TEXT_MAX_CHARS - 1) });
    await input(page, { kind: 'text', text: '😀z' });
    const out = await rec.stop(SID);
    const typed = out!.steps.filter((s) => s.type === 'type') as Array<{ text: string }>;
    const isLoneSurrogate = (str: string) =>
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(str);
    for (const s of typed) {
      expect(isLoneSurrogate(s.text)).toBe(false);
      expect(s.text.length).toBeLessThanOrEqual(DEMO_TYPED_TEXT_MAX_CHARS);
    }
    expect(
      typed
        .slice(0, 2)
        .map((s) => s.text)
        .join(''),
    ).toBe(text);
    expect(
      typed
        .slice(2)
        .map((s) => s.text)
        .join(''),
    ).toBe('b'.repeat(DEMO_TYPED_TEXT_MAX_CHARS - 1) + '😀z');
  });

  it('masks text typed into sensitive fields and when focus cannot be read', async () => {
    const state: { url: string; focused: DemoElementDescription | null } = {
      url,
      focused: field('#password', 'Password', true),
    };
    const page = fakePage(state);
    rec.start(SID);
    for (const ch of 'hunter2') await input(page, { kind: 'key', type: 'press', key: ch });
    await input(page, { kind: 'key', type: 'press', key: 'Backspace' });
    await input(page, { kind: 'key', type: 'press', key: 'Tab' });
    state.focused = null;
    page.describe.mockRejectedValueOnce(new Error('Execution context was destroyed'));
    await input(page, { kind: 'text', text: '123456' });
    const out = await rec.stop(SID);

    expect(out?.steps).toEqual([
      expect.objectContaining({
        type: 'type',
        selector: '#password',
        text: DEMO_MASKED_TEXT,
        masked: true,
      }),
      expect.objectContaining({ type: 'key', key: 'Backspace' }),
      expect.objectContaining({ type: 'key', key: 'Tab' }),
      expect.objectContaining({
        type: 'type',
        selector: null,
        text: DEMO_MASKED_TEXT,
        masked: true,
      }),
    ]);
    const json = JSON.stringify(out);
    expect(json).not.toContain('hunter');
    expect(json).not.toContain('123456');
  });

  it('masks printable keys that arrive with modifiers when the target is sensitive', async () => {
    const state: { url: string; focused: DemoElementDescription | null } = {
      url,
      focused: field('#pw', 'Password', true),
    };
    const page = fakePage(state);
    rec.start(SID);
    // AltGr characters reach the page as Ctrl+Alt + the printable key.
    await input(page, {
      kind: 'key',
      type: 'press',
      key: '@',
      modifiers: { ctrl: true, alt: true },
    });
    await input(page, {
      kind: 'key',
      type: 'down',
      key: '€',
      modifiers: { ctrl: true, alt: true },
    });
    await input(page, { kind: 'key', type: 'press', key: 'Enter' });
    // Unknown focus is treated the same way.
    state.focused = null;
    await input(page, { kind: 'key', type: 'press', key: 'ł', modifiers: { alt: true } });
    // In a plain field the shortcut stays readable.
    state.focused = field('#q', 'Search');
    await input(page, { kind: 'key', type: 'press', key: 'a', modifiers: { ctrl: true } });
    const out = await rec.stop(SID);
    expect(out?.steps).toEqual([
      expect.objectContaining({
        type: 'key',
        key: DEMO_MASKED_TEXT,
        masked: true,
        modifiers: ['Control', 'Alt'],
      }),
      expect.objectContaining({ type: 'key', key: DEMO_MASKED_TEXT, masked: true }),
      expect.objectContaining({ type: 'key', key: 'Enter' }),
      expect.objectContaining({ type: 'key', key: DEMO_MASKED_TEXT, masked: true }),
      expect.objectContaining({ type: 'key', key: 'a', modifiers: ['Control'] }),
    ]);
    expect(out?.steps[2]).not.toHaveProperty('masked');
    const json = JSON.stringify(out);
    for (const secret of ['"@"', '€', 'ł']) expect(json).not.toContain(secret);
  });

  it('masks a modified printable key when focus moves to a sensitive field as it lands', async () => {
    const state: { url: string; focused: DemoElementDescription | null } = {
      url,
      focused: field('#q', 'Search'),
    };
    const page = fakePage(state);
    rec.start(SID);
    await input(
      page,
      { kind: 'key', type: 'press', key: '#', modifiers: { ctrl: true, alt: true } },
      async () => {
        state.focused = field('#pin', 'PIN', true);
        return { ok: true };
      },
    );
    const out = await rec.stop(SID);
    expect(out?.steps).toEqual([
      expect.objectContaining({ type: 'key', key: DEMO_MASKED_TEXT, masked: true }),
    ]);
  });

  it('strips credentials from every recorded URL', async () => {
    url = 'https://ana:hunter2@example.com/start';
    rec.start(SID);
    url = 'https://ana:hunter2@example.com/inbox';
    vi.advanceTimersByTime(1_000);
    await urlBar('https://bob:pw@example.org/x');
    const out = await rec.stop(SID);
    expect(out?.startUrl).toBe('https://example.com/start');
    expect(out?.steps.map((s) => ('url' in s ? s.url : null))).toEqual([
      'https://example.com/inbox',
      'https://example.org/x',
    ]);
    expect(JSON.stringify(out)).not.toMatch(/hunter2|bob:pw|ana:/);
  });

  it('masks typing once page script moves focus into a password field mid-run', async () => {
    const state: { url: string; focused: DemoElementDescription | null } = {
      url,
      focused: field('#user', 'Username'),
    };
    const page = fakePage(state);
    rec.start(SID);
    for (const ch of 'ana') await input(page, { kind: 'key', type: 'press', key: ch });
    // No click, Tab or navigation: the page itself moves focus.
    state.focused = field('#user', 'Username', true);
    for (const ch of 's3cret') await input(page, { kind: 'key', type: 'press', key: ch });
    state.focused = field('#pin', 'PIN', true);
    await input(page, { kind: 'text', text: '9876' });
    const out = await rec.stop(SID);

    expect(out?.steps).toEqual([
      expect.objectContaining({ type: 'type', selector: '#user', text: 'ana', masked: false }),
      expect.objectContaining({
        type: 'type',
        selector: '#user',
        text: DEMO_MASKED_TEXT,
        masked: true,
      }),
      expect.objectContaining({
        type: 'type',
        selector: '#pin',
        text: DEMO_MASKED_TEXT,
        masked: true,
      }),
    ]);
    const json = JSON.stringify(out);
    expect(json).not.toContain('s3cret');
    expect(json).not.toContain('9876');
  });

  it('Stop waits for accepted input and a new recording never receives it', async () => {
    let releaseDescribe!: () => void;
    let releaseDispatch!: () => void;
    const describeGate = new Promise<void>((r) => (releaseDescribe = r));
    const dispatchGate = new Promise<void>((r) => (releaseDispatch = r));
    const page = fakePage({ url, at: field('#send', 'Send') });
    page.describe.mockImplementationOnce(async () => {
      await describeGate;
      return field('#send', 'Send');
    });
    rec.start(SID);
    const clicked = rec.record(
      SID,
      { kind: 'mouse', type: 'down', x: 3, y: 4 },
      () => page,
      async () => {
        await dispatchGate;
        return { ok: true };
      },
    );
    const typed = rec.record(SID, { kind: 'text', text: 'hi' }, () => page, ok);

    const stopped = rec.stop(SID);
    // The session is free at once; input arriving now belongs to the new recording.
    expect(rec.start(SID)).toMatchObject({ ok: true });
    const later = rec.record(SID, { kind: 'key', type: 'press', key: 'Enter' }, () => page, ok);

    releaseDescribe();
    await Promise.resolve();
    releaseDispatch();
    await Promise.all([clicked, typed, later]);
    const first = await stopped;
    const second = await rec.stop(SID);

    expect(first?.steps.map((s) => s.type)).toEqual(['click', 'type']);
    expect(first?.steps[0]).toMatchObject({ selector: '#send', text: 'Send' });
    expect(second?.steps).toEqual([expect.objectContaining({ type: 'key', key: 'Enter' })]);
    expect(saved.map((r) => r.steps.length)).toEqual([2, 1]);
  });

  it('keeps input order after Stop until queued input drains', async () => {
    let releaseInspect!: () => void;
    const inspectGate = new Promise<void>((r) => (releaseInspect = r));
    const page = fakePage({ url, at: field('#a', 'A') });
    page.describe.mockImplementationOnce(async () => {
      await inspectGate;
      return field('#a', 'A');
    });
    const order: string[] = [];
    const dispatch = (name: string) => async () => {
      order.push(name);
      return { ok: true };
    };
    rec.start(SID);
    const first = rec.record(
      SID,
      { kind: 'mouse', type: 'down', x: 1, y: 1 },
      () => page,
      dispatch('click'),
    );
    const stopped = rec.stop(SID);
    // Idle now, but the click is still queued: Enter must not overtake it.
    const second = rec.record(
      SID,
      { kind: 'key', type: 'press', key: 'Enter' },
      () => page,
      dispatch('enter'),
    );
    await Promise.resolve();
    expect(order).toEqual([]);
    releaseInspect();
    await Promise.all([first, second]);
    expect(order).toEqual(['click', 'enter']);
    expect((await stopped)?.steps).toEqual([
      expect.objectContaining({ type: 'click', selector: '#a' }),
    ]);
    // Once drained, idle input dispatches directly again.
    await rec.record(SID, { kind: 'key', type: 'press', key: 'Tab' }, () => page, dispatch('tab'));
    expect(order).toEqual(['click', 'enter', 'tab']);
  });

  it('records an action on the page it was made on, before the navigation it causes', async () => {
    const page = fakePage({
      url,
      at: { selector: 'a#next', text: 'Next', tag: 'a', sensitive: false },
    });
    rec.start(SID);
    // A click handler that pushState()s synchronously: the URL changes during dispatch.
    await input(page, { kind: 'mouse', type: 'down', x: 2, y: 2 }, async () => {
      url = 'https://example.com/step-2';
      vi.advanceTimersByTime(1_000); // the URL poll fires mid-dispatch
      return { ok: true };
    });
    await input(page, { kind: 'key', type: 'press', key: 'Enter' }, async () => {
      url = 'https://example.com/done';
      return { ok: true };
    });
    const out = await rec.stop(SID);
    expect(out?.steps.map((s) => [s.type, 'url' in s ? s.url : null])).toEqual([
      ['click', 'https://example.com/'],
      ['navigate', 'https://example.com/step-2'],
      ['key', 'https://example.com/step-2'],
      ['navigate', 'https://example.com/done'],
    ]);
  });

  /** Simulate an agent op: the recorder hears the same start/end events the screencast sends. */
  function agentOp(run: () => void): void {
    agentDriving = true;
    rec.observeAgentActivity(SID);
    run();
    agentDriving = false;
    rec.observeAgentActivity(SID);
  }

  function urlBar(to: string) {
    return rec.recordNavigation(SID, async () => {
      url = to;
      return { ok: true as const, url: to };
    });
  }

  it('records page and URL-bar navigations, but not ones the agent made', async () => {
    const page = fakePage({ url });
    rec.start(SID);
    url = 'https://example.com/inbox';
    vi.advanceTimersByTime(1_000);
    agentOp(() => {
      url = 'https://example.com/agent-went-here';
      vi.advanceTimersByTime(1_000);
    });
    url = 'https://example.com/settings';
    vi.advanceTimersByTime(1_000);
    await urlBar('https://other.example/');
    await input(page, { kind: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 100 });
    await input(page, { kind: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 50 });
    const out = await rec.stop(SID);

    expect(
      out?.steps.map((s) => [s.type, 'url' in s ? s.url : null, 'source' in s ? s.source : null]),
    ).toEqual([
      ['navigate', 'https://example.com/inbox', 'page'],
      ['navigate', 'https://example.com/settings', 'page'],
      ['navigate', 'https://other.example/', 'url_bar'],
      ['scroll', 'https://other.example/', null],
    ]);
    expect(out?.steps[3]).toMatchObject({ deltaY: 150 });
  });

  it('credits an agent navigation that starts and ends between polls to the agent', async () => {
    rec.start(SID);
    // A human page change before the agent starts is still the human's.
    url = 'https://example.com/human';
    agentOp(() => {
      url = 'https://example.com/agent-1';
    });
    vi.advanceTimersByTime(1_000);
    agentOp(() => {
      url = 'https://example.com/agent-2';
    });
    // Stop's final observation runs after the op too.
    const out = await rec.stop(SID);
    expect(out?.steps).toEqual([
      expect.objectContaining({
        type: 'navigate',
        url: 'https://example.com/human',
        source: 'page',
      }),
    ]);
  });

  it('does not credit the human with a URL change made while an agent op overlapped their input', async () => {
    const page = fakePage({ url, at: field('#x', 'X') });
    rec.start(SID);
    await input(page, { kind: 'mouse', type: 'down', x: 1, y: 1 }, async () => {
      agentOp(() => {
        url = 'https://example.com/agent';
      });
      return { ok: true };
    });
    const out = await rec.stop(SID);
    expect(out?.steps.map((s) => s.type)).toEqual(['click']);
  });

  it('starts a new typing step after an agent navigation, even into a same-named field', async () => {
    const page = fakePage({ url, focused: field('#q', 'Search') });
    rec.start(SID);
    for (const ch of 'cats') await input(page, { kind: 'key', type: 'press', key: ch });
    agentOp(() => {
      url = 'https://example.com/results';
    });
    // Page B also has a focused #q.
    for (const ch of 'dogs') await input(page, { kind: 'key', type: 'press', key: ch });
    await input(page, { kind: 'key', type: 'press', key: 'Backspace' });
    agentOp(() => {
      url = 'https://example.com/other';
    });
    await input(page, { kind: 'key', type: 'press', key: 'Backspace' });
    const out = await rec.stop(SID);
    expect(out?.steps).toEqual([
      expect.objectContaining({ type: 'type', url: 'https://example.com/', text: 'cats' }),
      expect.objectContaining({ type: 'type', url: 'https://example.com/results', text: 'dogs' }),
      expect.objectContaining({
        type: 'key',
        url: 'https://example.com/results',
        key: 'Backspace',
      }),
      expect.objectContaining({ type: 'key', url: 'https://example.com/other', key: 'Backspace' }),
    ]);
  });

  it('does not merge across agent activity that left the URL alone', async () => {
    const page = fakePage({ url, focused: field('#q', 'Search') });
    rec.start(SID);
    await input(page, { kind: 'text', text: 'ab' });
    agentOp(() => {});
    await input(page, { kind: 'text', text: 'cd' });
    await input(page, { kind: 'wheel', x: 0, y: 0, deltaX: 0, deltaY: 10 });
    agentOp(() => {});
    await input(page, { kind: 'wheel', x: 0, y: 0, deltaX: 0, deltaY: 10 });
    const out = await rec.stop(SID);
    expect(out?.steps.map((s) => s.type)).toEqual(['type', 'type', 'scroll', 'scroll']);
  });

  it('does not merge across a different page object at the same URL', async () => {
    const pageA = fakePage({ url, focused: field('#q', 'Search') });
    const pageB = fakePage({ url, focused: field('#q', 'Search') });
    let active: DemoPageLike = pageA;
    const send = (i: DemoViewerInput) => {
      now += 100;
      return rec.record(SID, i, () => active, ok);
    };
    rec.start(SID);
    await send({ kind: 'text', text: 'ab' });
    active = pageB; // the browser swapped in another page; same URL, same field
    await send({ kind: 'text', text: 'cd' });
    await send({ kind: 'wheel', x: 0, y: 0, deltaX: 0, deltaY: 5 });
    active = pageA;
    await send({ kind: 'wheel', x: 0, y: 0, deltaX: 0, deltaY: 5 });
    const out = await rec.stop(SID);
    expect(out?.steps.map((s) => [s.type, 'text' in s ? s.text : null])).toEqual([
      ['type', 'ab'],
      ['type', 'cd'],
      ['scroll', null],
      ['scroll', null],
    ]);
  });

  it('does not merge across a new document in the same page at the same URL', async () => {
    const state = { url, focused: field('#q', 'Search'), doc: 'doc-1' };
    const page = fakePage(state);
    rec.start(SID);
    await input(page, { kind: 'text', text: 'ab' });
    await input(page, { kind: 'text', text: 'cd' });
    state.doc = 'doc-2'; // reloaded: same URL, same page object, new document
    await input(page, { kind: 'text', text: 'ef' });
    const out = await rec.stop(SID);
    expect(out?.steps.map((s) => ('text' in s ? s.text : null))).toEqual(['abcd', 'ef']);
  });

  it('reads the document token and the target in one round trip', async () => {
    const page = fakePage({ url, focused: field('#q', 'Search') });
    rec.start(SID);
    await input(page, { kind: 'text', text: 'a' });
    await input(page, { kind: 'wheel', x: 0, y: 0, deltaX: 0, deltaY: 1 });
    await input(page, { kind: 'mouse', type: 'down', x: 1, y: 1 });
    await rec.stop(SID);
    // text: inspect + confirm; scroll: inspect + confirm; click: inspect. Each
    // read is a single script carrying both the token and the target.
    const scripts = page.evaluate.mock.calls.map(([s]) => String(s));
    expect(scripts).toHaveLength(5);
    for (const s of scripts) expect(s.startsWith(PAGE_READ_MARKER)).toBe(true);
  });

  it('a reload between inspection and delivery splits the step and masks the typing', async () => {
    const state = { url, focused: field('#q', 'Search'), doc: 'doc-1' };
    const page = fakePage(state);
    rec.start(SID);
    await input(page, { kind: 'text', text: 'ab' });
    // The page reloads at the same URL after this input was inspected but
    // before its keys land, into an identically named field.
    await input(page, { kind: 'text', text: 'cd' }, async () => {
      state.doc = 'doc-2';
      return { ok: true };
    });
    await input(page, { kind: 'text', text: 'ef' });
    const out = await rec.stop(SID);
    expect(out?.steps).toEqual([
      expect.objectContaining({ type: 'type', text: 'ab', masked: false }),
      expect.objectContaining({ type: 'type', text: DEMO_MASKED_TEXT, masked: true }),
      expect.objectContaining({ type: 'type', text: 'ef', masked: false }),
    ]);
  });

  it('never merges, and masks typing, when the document cannot be identified', async () => {
    const page = fakePage({ url, focused: field('#q', 'Search') });
    page.evaluate.mockImplementation(async () => ({
      doc: undefined,
      target: field('#q', 'Search'),
    }));
    rec.start(SID);
    await input(page, { kind: 'text', text: 'ab' });
    await input(page, { kind: 'text', text: 'cd' });
    const out = await rec.stop(SID);
    // Without a document token the recorder can't prove the keys landed in the
    // document it inspected, so it fails closed: masked, and never merged.
    expect(out?.steps).toEqual([
      expect.objectContaining({ type: 'type', text: DEMO_MASKED_TEXT, masked: true }),
      expect.objectContaining({ type: 'type', text: DEMO_MASKED_TEXT, masked: true }),
    ]);
  });

  it('does not merge typing across a page navigation the human caused', async () => {
    const page = fakePage({ url, focused: field('#q', 'Search') });
    rec.start(SID);
    await input(page, { kind: 'text', text: 'ab' });
    url = 'https://example.com/next';
    vi.advanceTimersByTime(1_000);
    await input(page, { kind: 'text', text: 'cd' });
    const out = await rec.stop(SID);
    expect(out?.steps.map((s) => [s.type, 'text' in s ? s.text : null])).toEqual([
      ['type', 'ab'],
      ['navigate', null],
      ['type', 'cd'],
    ]);
  });

  it('re-inspects when an agent op changes focus and finishes while inspection runs', async () => {
    const state: { url: string; focused: DemoElementDescription | null } = {
      url,
      focused: field('#q', 'Search'),
    };
    const page = fakePage(state);
    let calls = 0;
    page.describe.mockImplementation(async () => {
      calls += 1;
      const seen = state.focused;
      if (calls === 1) {
        // Inspection read the plain field; then the agent moves focus to a
        // password field and its op ends before inspection resolves.
        agentOp(() => {
          state.focused = field('#pw', 'Password', true);
        });
      }
      return seen;
    });
    rec.start(SID);
    await input(page, { kind: 'text', text: 'hunter2' });
    const out = await rec.stop(SID);
    expect(out?.steps).toEqual([
      expect.objectContaining({
        type: 'type',
        selector: '#pw',
        text: DEMO_MASKED_TEXT,
        masked: true,
      }),
    ]);
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  it('fails closed when the browser keeps changing under inspection', async () => {
    const page = fakePage({ url, focused: field('#q', 'Search'), at: field('#b', 'B') });
    page.describe.mockImplementation(async (script: string) => {
      agentOp(() => {});
      return script.endsWith('(null)') ? field('#q', 'Search') : field('#b', 'B');
    });
    rec.start(SID);
    await input(page, { kind: 'text', text: 'abc' });
    await input(page, { kind: 'mouse', type: 'down', x: 1, y: 1 });
    const out = await rec.stop(SID);
    expect(out?.steps).toEqual([
      expect.objectContaining({
        type: 'type',
        selector: null,
        text: DEMO_MASKED_TEXT,
        masked: true,
      }),
      expect.objectContaining({ type: 'click', selector: null, text: null }),
    ]);
  });

  it('masks text when focus moves to a sensitive field while it is delivered', async () => {
    const state: { url: string; focused: DemoElementDescription | null } = {
      url,
      focused: field('#q', 'Search'),
    };
    const page = fakePage(state);
    rec.start(SID);
    await input(page, { kind: 'text', text: '1234' }, async () => {
      // Page script swaps to a PIN field as the keys land.
      state.focused = field('#pin', 'PIN', true);
      return { ok: true };
    });
    const out = await rec.stop(SID);
    expect(out?.steps).toEqual([
      expect.objectContaining({ type: 'type', text: DEMO_MASKED_TEXT, masked: true }),
    ]);
    expect(JSON.stringify(out)).not.toContain('1234');
  });

  it('keeps the typing step ahead of a navigation seen during the post-input focus check', async () => {
    const page = fakePage({ url, focused: field('#q', 'Search') });
    let releaseConfirm!: () => void;
    const confirmGate = new Promise<void>((r) => (releaseConfirm = r));
    let focusReads = 0;
    page.describe.mockImplementation(async () => {
      focusReads += 1;
      // The second read is the confirmation after delivery: hold it.
      if (focusReads === 2) await confirmGate;
      return field('#q', 'Search');
    });
    rec.start(SID);
    const typed = input(page, { kind: 'key', type: 'press', key: 'Enter' }, async () => ({
      ok: true,
    }));
    await typed;
    const submitted = rec.record(
      SID,
      { kind: 'text', text: 'shoes' },
      () => page,
      async () => {
        // Typing submits a search form that changes the route.
        url = 'https://example.com/results';
        return { ok: true };
      },
    );
    await vi.waitFor(() => expect(focusReads).toBe(2));
    vi.advanceTimersByTime(1_000); // the URL poll fires while confirmation is pending
    releaseConfirm();
    await submitted;
    const out = await rec.stop(SID);
    expect(out?.steps.map((s) => [s.type, 'url' in s ? s.url : null])).toEqual([
      ['key', 'https://example.com/'],
      ['type', 'https://example.com/'],
      ['navigate', 'https://example.com/results'],
    ]);
  });

  it('a recording draining after Stop still credits agent navigation to the agent', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const page = fakePage({ url, at: field('#x', 'X') });
    rec.start(SID);
    const clicked = rec.record(
      SID,
      { kind: 'mouse', type: 'down', x: 1, y: 1 },
      () => page,
      async () => {
        await gate;
        return { ok: true };
      },
    );
    const stopped = rec.stop(SID);
    await Promise.resolve();
    agentOp(() => {
      url = 'https://example.com/agent';
    });
    release();
    await clicked;
    expect((await stopped)?.steps.map((s) => s.type)).toEqual(['click']);
  });

  it('queues a URL-bar navigation behind input still being inspected', async () => {
    let releaseInspect!: () => void;
    const inspectGate = new Promise<void>((r) => (releaseInspect = r));
    const page = fakePage({ url, focused: field('#q', 'Search') });
    page.describe.mockImplementationOnce(async () => {
      await inspectGate;
      return field('#q', 'Search');
    });
    const order: string[] = [];
    rec.start(SID);
    const typed = rec.record(
      SID,
      { kind: 'text', text: 'shoes' },
      () => page,
      async () => {
        order.push(`type@${url}`);
        return { ok: true };
      },
    );
    const navigated = rec.recordNavigation(SID, async () => {
      order.push('navigate');
      url = 'https://example.com/results';
      return { ok: true as const, url };
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    releaseInspect();
    await Promise.all([typed, navigated]);
    expect(order).toEqual(['type@https://example.com/', 'navigate']);
    const out = await rec.stop(SID);
    expect(out?.steps).toEqual([
      expect.objectContaining({
        type: 'type',
        url: 'https://example.com/',
        selector: '#q',
        text: 'shoes',
      }),
      expect.objectContaining({
        type: 'navigate',
        url: 'https://example.com/results',
        source: 'url_bar',
      }),
    ]);
  });

  it('binds a URL-bar navigation to the recording that accepted it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    rec.start(SID);
    const navigated = rec.recordNavigation(SID, async () => {
      await gate;
      url = 'https://example.com/a';
      return { ok: true as const, url };
    });
    const stopped = rec.stop(SID);
    expect(rec.start(SID)).toMatchObject({ ok: true });
    release();
    await navigated;
    expect((await stopped)?.steps).toEqual([
      expect.objectContaining({
        type: 'navigate',
        url: 'https://example.com/a',
        source: 'url_bar',
      }),
    ]);
    expect((await rec.stop(SID))?.steps).toEqual([]);
  });

  it('does not record inputs the browser refused, or anything while idle', async () => {
    const page = fakePage({ url, at: field('#x', 'X') });
    await input(page, { kind: 'mouse', type: 'down', x: 1, y: 1 });
    expect(page.evaluate).not.toHaveBeenCalled();
    rec.start(SID);
    await input(page, { kind: 'mouse', type: 'down', x: 1, y: 1 }, async () => ({
      ok: false as const,
    }));
    expect((await rec.stop(SID))?.steps).toEqual([]);
  });

  it('stops and saves at the 10 minute cap', async () => {
    const events: string[] = [];
    rec.subscribe((ev) => events.push(ev.type === 'state' ? `state:${ev.state.active}` : ev.type));
    const started = rec.start(SID);
    expect(started).toMatchObject({
      ok: true,
      state: { active: true, endsAt: now + DEMO_RECORDING_MAX_MS },
    });
    expect(rec.start(SID)).toMatchObject({ ok: false });
    now += DEMO_RECORDING_MAX_MS;
    await vi.advanceTimersByTimeAsync(DEMO_RECORDING_MAX_MS);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      kind: 'agent-hub.browser-demo',
      sessionId: SID,
      stopReason: 'time_limit',
      durationMs: DEMO_RECORDING_MAX_MS,
      startUrl: 'https://example.com/',
    });
    expect(events).toEqual(['state:true', 'state:false', 'saved']);
    expect(rec.isRecording(SID)).toBe(false);
  });

  it('reports a failed save', async () => {
    rec.configure({ save: async () => Promise.reject(new Error('disk full')) });
    const events: unknown[] = [];
    rec.subscribe((ev) => events.push(ev));
    rec.start(SID);
    await rec.stop(SID);
    expect(events).toContainEqual({ type: 'save_failed', sessionId: SID, message: 'disk full' });
  });
});

describe('demoRecordingFilename', () => {
  it('stamps the start time', () => {
    expect(demoRecordingFilename('2026-10-16T13:45:01.123Z')).toBe(
      'browser-demo-20261016-134501.json',
    );
  });
});
