import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';

// Relaunches (the restart-notice case) get a fake page instead of Chromium.
vi.mock('./browser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser.js')>();
  return {
    ...actual,
    launchBrowserSession: vi.fn(async (opts: { id?: string }) => {
      const id = opts.id ?? 'relaunched';
      const s = {
        id,
        page: {
          url: () => 'about:blank',
          evaluate: async () => '',
          locator: () => ({}),
          screenshot: async () => Buffer.from([]),
          goto: async () => null,
        },
        createdAt: Date.now(),
        timeoutMs: actual.DEFAULT_TIMEOUT_MS,
        close: async () => actual.__unregisterBrowserSessionForTests(id),
      };
      actual.__registerBrowserSessionForTests(s as never);
      return s;
    }),
  };
});
import {
  type SelectOptionInfo,
  browserReadPage,
  browserSelect,
  browserToolStartLabel,
  matchSelectOption,
  runBrowserReActStep,
  __resetChatsWithBrowserForTests,
} from './browser-tools.js';
import {
  __registerBrowserSessionForTests,
  __resetBrowserRegistryForTests,
  __unregisterBrowserSessionForTests,
  bumpBrowserSessionActivity,
  incrementBrowserToolOpEntered,
  notifyBrowserToolOpEnded,
  pickBrowserSessionToEvict,
  resolveDefaultChromiumPath,
  DEFAULT_TIMEOUT_MS,
  type BrowserSession,
} from './browser.js';
import { isGatedBrowserOp } from './browser-domain-policy.js';
import { parseReActBlock } from './chat.js';

type Opt = { value: string; label: string; disabled: boolean };
const withIndex = (opts: Opt[]): SelectOptionInfo[] => opts.map((o, index) => ({ index, ...o }));
const OPTIONS = withIndex([
  { value: '', label: 'Select…', disabled: true },
  { value: 'express2', label: 'Express 2-Day', disabled: false },
  { value: 'overnight', label: 'Overnight', disabled: false },
  { value: 'ground', label: 'Standard Ground', disabled: false },
]);

function fakeSession(id: string, page: unknown): BrowserSession {
  return {
    id,
    page,
    createdAt: Date.now(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    close: async () => {
      __unregisterBrowserSessionForTests(id);
    },
  } as unknown as BrowserSession;
}

/**
 * A fake `<select>`: `evaluate` runs the real in-page function against it and
 * `selectOption({ index })` moves `selectedIndex`, so both the option read
 * and the post-select verification are exercised. `onSelect` lets a test
 * play a page script that rewrites the selection.
 */
function selectPage(
  opts: {
    isSelect?: boolean;
    labelMatches?: number;
    options?: Opt[];
    onSelect?: (el: {
      selectedIndex: number;
      options: Array<{ value: string; label: string; textContent: string }>;
    }) => void;
  } = {},
) {
  const el = {
    tagName: opts.isSelect === false ? 'INPUT' : 'SELECT',
    options: (opts.options ?? OPTIONS).map((o) => ({
      value: o.value,
      label: o.label,
      textContent: o.label,
      disabled: o.disabled,
    })),
    selectedIndex: 0,
  };
  const selectOption = vi.fn(async (v: { index?: number }) => {
    el.selectedIndex = v.index ?? -1;
    opts.onSelect?.(el);
    return [el.options[el.selectedIndex]?.value ?? ''];
  });
  const evaluate = vi.fn(async (fn: (e: unknown) => unknown) => fn(el));
  const loc = {
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    selectOption,
    evaluate,
  };
  const page = {
    url: () => 'https://app.example.com/orders/new',
    goto: vi.fn(async () => null),
    screenshot: vi.fn(async () => Buffer.from([])),
    evaluate: vi.fn(async () => ''),
    locator: vi.fn(() => loc),
    getByLabel: vi.fn(() => ({
      count: async () => opts.labelMatches ?? 1,
      first: () => loc,
    })),
    getByText: vi.fn(() => ({
      count: async () => 0,
      first: () => ({ click: vi.fn(async () => {}) }),
    })),
  };
  return { page, loc, selectOption, el };
}

describe('matchSelectOption', () => {
  it('matches exact value, then label case-insensitively', () => {
    expect(matchSelectOption(OPTIONS, 'overnight')?.value).toBe('overnight');
    expect(matchSelectOption(OPTIONS, 'express 2-day')?.value).toBe('express2');
    expect(matchSelectOption(OPTIONS, '  EXPRESS   2-Day ')?.value).toBe('express2');
  });

  it('accepts a unique prefix or substring, and refuses ambiguous ones', () => {
    expect(matchSelectOption(OPTIONS, 'Standard')?.value).toBe('ground');
    expect(matchSelectOption(OPTIONS, 'Express')?.value).toBe('express2');
    expect(matchSelectOption(OPTIONS, '2-Day')?.value).toBe('express2');
    expect(matchSelectOption(OPTIONS, 'r')).toBeNull();
  });

  it('stops at an ambiguous tier instead of falling through to a looser one', () => {
    const dupes = withIndex([
      { value: 'a', label: 'Express', disabled: false },
      { value: 'b', label: 'Express', disabled: false },
      { value: 'c', label: 'Express Plus', disabled: false },
    ]);
    expect(matchSelectOption(dupes, 'Express')).toBeNull();
    const identical = withIndex([
      { value: 'a', label: 'Express', disabled: false },
      { value: 'a', label: 'Express', disabled: false },
    ]);
    expect(matchSelectOption(identical, 'Express')?.index).toBe(0);
  });

  it('never picks a disabled placeholder', () => {
    expect(matchSelectOption(OPTIONS, 'Select…')).toBeNull();
  });
});

describe('browserSelect', () => {
  it('selects by label through a CSS selector, by the matched option value', async () => {
    const { page, selectOption } = selectPage();
    const r = await browserSelect({ page }, '#shippingMethod', 'Express 2-Day');
    expect(r.ok).toBe(true);
    expect(page.locator).toHaveBeenCalledWith('#shippingMethod');
    expect(selectOption).toHaveBeenCalledWith({ index: 1 }, { timeout: 10_000 });
    expect(r.data).toMatchObject({ method: 'locator', value: 'express2', label: 'Express 2-Day' });
  });

  it('resolves a natural-language target through the field label', async () => {
    const { page, selectOption } = selectPage();
    const r = await browserSelect({ page }, 'Shipping Method', 'Express 2-Day');
    expect(r.ok).toBe(true);
    expect(page.getByLabel).toHaveBeenCalledWith('Shipping Method', { exact: false });
    expect(selectOption).toHaveBeenCalled();
    expect(r.data).toMatchObject({ method: 'getByLabel' });
  });

  it('lists the options when nothing matches', async () => {
    const { page, selectOption } = selectPage();
    const r = await browserSelect({ page }, '#shippingMethod', 'Freight');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('"Express 2-Day" (value "express2")');
    expect(selectOption).not.toHaveBeenCalled();
  });

  it('selects an enabled empty-value option to clear the field', async () => {
    const { page, selectOption, el } = selectPage({
      options: [{ value: '', label: '', disabled: false }, ...OPTIONS.slice(1)],
    });
    el.selectedIndex = 2;
    const r = await browserSelect({ page }, '#shippingMethod', '');
    expect(r.ok, r.error).toBe(true);
    expect(selectOption).toHaveBeenCalledWith({ index: 0 }, { timeout: 10_000 });
    expect(el.selectedIndex).toBe(0);
  });

  it('selects the matched option by index when values repeat', async () => {
    const { page, selectOption, el } = selectPage({
      options: [
        { value: 'same', label: 'Standard', disabled: false },
        { value: 'same', label: 'Express', disabled: false },
      ],
    });
    const r = await browserSelect({ page }, '#shippingMethod', 'Express');
    expect(r.ok, r.error).toBe(true);
    expect(selectOption).toHaveBeenCalledWith({ index: 1 }, { timeout: 10_000 });
    expect(el.selectedIndex).toBe(1);
    expect(r.data).toMatchObject({ index: 1, label: 'Express' });
  });

  it('refuses a value shared by options with different labels', async () => {
    const { page, selectOption } = selectPage({
      options: [
        { value: 'same', label: 'Standard', disabled: false },
        { value: 'same', label: 'Express', disabled: false },
      ],
    });
    const r = await browserSelect({ page }, '#shippingMethod', 'same');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No single option matches "same"/);
    expect(selectOption).not.toHaveBeenCalled();
  });

  it('fails when the page rewrites the selection, instead of reporting the request', async () => {
    const { page } = selectPage({
      onSelect: (el) => {
        el.selectedIndex = 3;
      },
    });
    const r = await browserSelect({ page }, '#shippingMethod', 'Overnight');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/field now shows "Standard Ground"/);
  });

  it('fails when the page rewrites the chosen option in place (same index)', async () => {
    const valueRewrite = selectPage({
      onSelect: (el) => {
        el.options[el.selectedIndex].value = 'ground';
      },
    });
    const v = await browserSelect({ page: valueRewrite.page }, '#shippingMethod', 'Overnight');
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/field now shows "Overnight" \(value "ground"\)/);
    expect(v.data).toMatchObject({ now: { index: 2, value: 'ground' } });

    const labelRewrite = selectPage({
      onSelect: (el) => {
        el.options[el.selectedIndex].label = 'Overnight (sold out)';
      },
    });
    const l = await browserSelect({ page: labelRewrite.page }, '#shippingMethod', 'Overnight');
    expect(l.ok).toBe(false);
    expect(l.error).toMatch(/field now shows "Overnight \(sold out\)"/);
  });

  it('reports the option the page holds after the select', async () => {
    const { page } = selectPage();
    const r = await browserSelect({ page }, '#shippingMethod', 'overnight');
    expect(r.ok, r.error).toBe(true);
    expect(r.data).toEqual({ method: 'locator', index: 2, value: 'overnight', label: 'Overnight' });
  });

  it('rejects a missing value but not an empty one', async () => {
    const { page } = selectPage();
    const r = await browserSelect({ page }, '#shippingMethod', undefined);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/value is required/);
  });

  it('bounds the option read and stops when the selector never resolves', async () => {
    const { page, loc, selectOption } = selectPage();
    const evaluate = vi.fn(async () => {
      throw new Error('locator.evaluate: Timeout 10000ms exceeded.\nCall log: …');
    });
    loc.evaluate = evaluate as never;
    const r = await browserSelect({ page }, '#nope', 'Overnight');
    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), undefined, { timeout: 10_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Could not find "#nope" within 10s.*read_page/);
    expect(selectOption).not.toHaveBeenCalled();
  });

  it('points custom dropdowns at click', async () => {
    const { page } = selectPage({ isSelect: false });
    const r = await browserSelect({ page }, '#fancy', 'Express 2-Day');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not a native <select>.*click/);
  });

  it('fails fast with a read_page hint when no field has that label', async () => {
    const { page } = selectPage({ labelMatches: 0 });
    const r = await browserSelect({ page }, 'Nonexistent field', 'x');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/read_page/);
  });
});

describe('runBrowserReActStep — select and fast failure', () => {
  beforeEach(() => {
    __resetBrowserRegistryForTests();
    __resetChatsWithBrowserForTests();
  });
  afterEach(() => __resetBrowserRegistryForTests());

  it('runs select and reports the chosen option', async () => {
    const { page } = selectPage();
    __registerBrowserSessionForTests(fakeSession('sel-1', page));
    const r = await runBrowserReActStep('sel-1', {
      op: 'select',
      target: '#shippingMethod',
      text: 'Express 2-Day',
    });
    expect(r.hostExit).toBe(0);
    expect(r.ui?.summary).toBe('Selected Express 2-Day');
    expect(r.markdown).toContain('Browser: select');
  });

  it('select goes through the domain gate like type', async () => {
    const { page, selectOption } = selectPage();
    __registerBrowserSessionForTests(fakeSession('sel-gate', page));
    const gate = vi.fn(async () => ({
      proceed: false as const,
      markdown: '## Browser: select refused',
      hostDetail: 'blocked_domain',
      summary: 'Blocked',
      halt: 'blocked',
    }));
    const r = await runBrowserReActStep(
      'sel-gate',
      { op: 'select', target: '#shippingMethod', text: 'Express 2-Day' },
      {},
      undefined,
      {},
      Object.assign(gate, { blockedBy: () => null }) as never,
    );
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ op: 'select' }));
    expect(r.hostExit).toBe(2);
    expect(selectOption).not.toHaveBeenCalled();
    expect(isGatedBrowserOp('select')).toBe(true);
  });

  it('natural-language click with no text match fails without waiting on a click', async () => {
    const { page } = selectPage();
    const clickSpy = vi.fn(async () => {});
    page.getByText = vi.fn(() => ({ count: async () => 0, first: () => ({ click: clickSpy }) }));
    __registerBrowserSessionForTests(fakeSession('click-miss', page));
    const r = await runBrowserReActStep('click-miss', {
      op: 'click',
      target: 'the Shipping Method dropdown',
    });
    expect(r.hostExit).toBe(1);
    expect(clickSpy).not.toHaveBeenCalled();
    expect(r.markdown).toMatch(/read_page/);
  });
});

describe('runBrowserReActStep — restart notice', () => {
  beforeEach(() => {
    __resetBrowserRegistryForTests();
    __resetChatsWithBrowserForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetBrowserRegistryForTests();
  });

  it('tells the agent when the browser it used was closed and reopened blank', async () => {
    const { page } = selectPage();
    __registerBrowserSessionForTests(fakeSession('restart-1', page));
    const first = await runBrowserReActStep('restart-1', { op: 'read_page' });
    expect(first.markdown).not.toContain('Browser restarted');

    // Idle close drops the session; the next step relaunches on about:blank.
    __unregisterBrowserSessionForTests('restart-1');
    const second = await runBrowserReActStep('restart-1', { op: 'read_page' });
    expect(second.markdown).toContain('Browser restarted');

    // A first-ever launch is not a restart.
    const brandNew = await runBrowserReActStep('never-had-one', { op: 'read_page' });
    expect(brandNew.markdown).not.toContain('Browser restarted');
  });
});

describe('browser capacity eviction', () => {
  beforeEach(() => __resetBrowserRegistryForTests());
  afterEach(() => __resetBrowserRegistryForTests());

  it('picks the longest-idle session that has no step in flight', () => {
    vi.useFakeTimers();
    try {
      for (const id of ['a', 'b', 'c']) __registerBrowserSessionForTests(fakeSession(id, {}));
      vi.setSystemTime(1_000);
      bumpBrowserSessionActivity('a');
      vi.setSystemTime(2_000);
      bumpBrowserSessionActivity('b');
      vi.setSystemTime(3_000);
      bumpBrowserSessionActivity('c');
      incrementBrowserToolOpEntered('a');
      expect(pickBrowserSessionToEvict(4_000)).toBe('b');
      notifyBrowserToolOpEnded('a');
      // Ending the op bumps `a` to now, so `b` is still the oldest.
      expect(pickBrowserSessionToEvict(4_000)).toBe('b');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null when every session is busy', () => {
    __registerBrowserSessionForTests(fakeSession('busy', {}));
    incrementBrowserToolOpEntered('busy');
    expect(pickBrowserSessionToEvict()).toBeNull();
  });
});

describe('ReAct parsing for select', () => {
  it('accepts value / option / label as the option operand', () => {
    for (const key of ['value', 'option', 'label', 'text']) {
      const r = parseReActBlock(
        `<agenthub:react>{"actions":[{"tool":"browser","op":"select","target":"#rc","${key}":"Express 2-Day"}]}</agenthub:react>`,
      );
      expect('error' in r, key).toBe(false);
      if (!('error' in r))
        expect(r.actions[0]).toMatchObject({ op: 'select', text: 'Express 2-Day' });
    }
  });

  it('rejects select without a value, for browser and preview', () => {
    for (const tool of ['browser', 'preview']) {
      const r = parseReActBlock(
        `<agenthub:react>{"actions":[{"tool":"${tool}","op":"select","target":"#rc"}]}</agenthub:react>`,
      );
      expect('error' in r).toBe(true);
    }
  });

  it('keeps an explicit empty value (clearing an optional select), for browser and preview', () => {
    for (const tool of ['browser', 'preview']) {
      for (const key of ['value', 'option', 'text']) {
        const r = parseReActBlock(
          `<agenthub:react>{"actions":[{"tool":"${tool}","op":"select","target":"#rc","${key}":""}]}</agenthub:react>`,
        );
        expect('error' in r, `${tool}/${key}`).toBe(false);
        if (!('error' in r)) expect(r.actions[0]).toMatchObject({ op: 'select', text: '' });
      }
    }
  });

  it('labels the select step for the activity strip', () => {
    expect(
      browserToolStartLabel({ op: 'select', target: '#shippingMethod', text: 'Express 2-Day' }),
    ).toBe('Choosing "Express 2-Day" in #shippingMethod…');
  });
});

// Real Chromium: proves selectOption and the read_page field map work against
// an actual <select>, not just the fakes above.
const chromiumPath = await resolveDefaultChromiumPath();
const chromiumInstalled = Boolean(chromiumPath && existsSync(chromiumPath));

describe.skipIf(!chromiumInstalled)('select + read_page against real Chromium', () => {
  it('lists the form and sets a native select by label', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({
      headless: true,
      executablePath: chromiumPath ?? undefined,
      args: ['--no-sandbox'],
    });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <form>
          <label for="fullname">Full Name</label><input id="fullname" value="Ada Lovelace" required>
          <label>Shipping Method
            <select name="shippingMethod" required>
              <option value="" disabled selected>Select…</option>
              <option value="express2">Express 2-Day</option>
              <option value="overnight">Overnight</option>
            </select>
          </label>
          <input type="hidden" name="csrf" value="secret">
          <input type="password" name="pw" value="hunter2">
          <button type="submit">Save</button>
        </form>`);
      const host = { page };

      const rp = await browserReadPage(host);
      expect(rp.ok).toBe(true);
      const fields = (rp.data as { fields: Array<Record<string, unknown>> }).fields;
      const select = fields.find((f) => f.tag === 'select');
      expect(select).toMatchObject({
        selector: 'select[name="shippingMethod"]',
        label: expect.stringContaining('Shipping Method'),
        options: ['Select…', 'Express 2-Day', 'Overnight'],
        required: true,
      });
      expect(fields.find((f) => f.selector === '#fullname')).toMatchObject({
        value: 'Ada Lovelace',
      });
      expect(fields.some((f) => f.selector === 'input[name="csrf"]')).toBe(false);
      expect(JSON.stringify(fields)).not.toContain('hunter2');

      const bySelector = await browserSelect(host, String(select!.selector), 'Overnight');
      expect(bySelector.ok, bySelector.error).toBe(true);
      expect(await page.$eval('select', (el) => (el as HTMLSelectElement).value)).toBe('overnight');

      const byLabel = await browserSelect(host, 'Shipping Method', 'Express 2-Day');
      expect(byLabel.ok, byLabel.error).toBe(true);
      expect(await page.$eval('select', (el) => (el as HTMLSelectElement).value)).toBe('express2');

      const notSelect = await browserSelect(host, '#fullname', 'x');
      expect(notSelect.error).toMatch(/not a native <select>/);

      // An optional select reset to its enabled, label-less empty option.
      await page.setContent(`
        <select name="giftWrap">
          <option value=""></option>
          <option value="paper">Paper</option>
        </select>`);
      await page.selectOption('select', 'paper');
      const cleared = await browserSelect(host, 'select[name="giftWrap"]', '');
      expect(cleared.ok, cleared.error).toBe(true);
      expect(await page.$eval('select', (el) => (el as HTMLSelectElement).value)).toBe('');

      // Duplicate values, distinct labels: the matched option itself is chosen.
      await page.setContent(`
        <select name="speed">
          <option value="same">Standard</option>
          <option value="same">Express</option>
        </select>`);
      const dup = await browserSelect(host, 'select[name="speed"]', 'Express');
      expect(dup.ok, dup.error).toBe(true);
      expect(await page.$eval('select', (el) => (el as HTMLSelectElement).selectedIndex)).toBe(1);
      expect(dup.data).toMatchObject({ index: 1, label: 'Express' });

      // A change handler that rewrites the choice is reported, not hidden.
      await page.setContent(`
        <select name="locked" onchange="this.selectedIndex = 0">
          <option value="a">Alpha</option>
          <option value="b">Beta</option>
        </select>`);
      const reverted = await browserSelect(host, 'select[name="locked"]', 'Beta');
      expect(reverted.ok).toBe(false);
      expect(reverted.error).toMatch(/field now shows "Alpha"/);

      // Index kept, chosen option rewritten in place by the handler.
      await page.setContent(`
        <select name="rewrite"
          onchange="const o = this.options[this.selectedIndex]; o.value = 'b2'; o.text = 'Beta (changed)'">
          <option value="a">Alpha</option>
          <option value="b">Beta</option>
        </select>`);
      const rewritten = await browserSelect(host, 'select[name="rewrite"]', 'Beta');
      expect(rewritten.ok).toBe(false);
      expect(rewritten.error).toMatch(/field now shows "Beta \(changed\)" \(value "b2"\)/);
      expect(rewritten.data).toMatchObject({ now: { index: 1, value: 'b2' } });

      // A selector that never matches fails within the action bound, not the
      // 30s page default.
      page.setDefaultTimeout(30_000);
      const started = Date.now();
      const missing = await browserSelect(host, '#doesNotExist', 'Paper');
      expect(missing.ok).toBe(false);
      expect(missing.error).toMatch(/Could not find "#doesNotExist"/);
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
