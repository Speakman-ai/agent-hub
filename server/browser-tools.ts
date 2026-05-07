/**
 * browser-tools.ts — High-level browser operations for agent chat sessions.
 *
 * Uses Stagehand (`act`, `extract`, `observe`) for natural-language targets and
 * Stagehand's CDP `Page.locator()` for CSS/XPath-style selectors. One browser
 * per chat session id (see {@link getOrCreateBrowserSessionForChat}).
 */

import { jsonSchemaToZod, type JsonSchema } from '@browserbasehq/stagehand';
import type { V3 } from '@browserbasehq/stagehand';
import {
  getBrowserSession,
  launchBrowserSession,
  closeBrowserSession,
  type BrowserSession,
  type BrowserSessionOptions,
} from './browser.js';

// ─── Types ───────────────────────────────────────────────────────

export type BrowserToolOp =
  | 'navigate'
  | 'click'
  | 'type'
  | 'extract'
  | 'screenshot'
  | 'scroll'
  | 'back'
  | 'forward'
  | 'wait'
  | 'read_page'
  | 'close';

export interface BrowserToolResult {
  ok: boolean;
  op: BrowserToolOp;
  data?: unknown;
  error?: string;
  /** Present for screenshot op — PNG base64 (no data: prefix). */
  imageBase64?: string;
}

/** Fields parsed from `<agenthub:react>` browser actions (see chat.ts). */
export interface BrowserReActActionInput {
  /** Parsed from JSON — validated in {@link runBrowserReActStep}. */
  op: string;
  url?: string;
  /** click / type target — natural language or selector string. */
  target?: string;
  text?: string;
  instruction?: string;
  /** Optional JSON-schema–shaped object for structured extract (Stagehand). */
  schema?: Record<string, unknown>;
  direction?: string;
  condition?: string;
}

const SCROLL_DELTA_PX = 720;

const VALID_BROWSER_OPS = new Set<string>([
  'navigate',
  'click',
  'type',
  'extract',
  'screenshot',
  'scroll',
  'back',
  'forward',
  'wait',
  'read_page',
  'close',
]);

function asV3(stagehand: unknown): V3 {
  return stagehand as V3;
}

/**
 * Heuristic: treat as a selector when it looks like CSS/XPath/Playwright-style,
 * not a prose phrase (which goes to Stagehand `act`).
 */
export function looksLikeSelectorTarget(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  if (t.includes('\n')) return false;
  // Prose / natural language — spaces without selector bits
  if (/[\s\u00a0]/.test(t) && !t.includes('>>') && !/[[(]/.test(t)) return false;
  if (t.startsWith('//') || t.startsWith('(//')) return true;
  if (t.includes('>>')) return true;
  if (t.startsWith('#') || t.startsWith('.') || t.startsWith('[')) return true;
  if (/^(xpath|text|role|internal:|aria-|data-testid=)/i.test(t)) return true;
  // Alphanumeric + hyphens tag or simple compound: `div`, `button#x`
  if (/^[a-zA-Z][\w-]*([#.][\w-]+)?$/.test(t)) return true;
  return /^[#.[\w*]/.test(t);
}

function getActivePage(stagehand: V3) {
  let page = stagehand.context.activePage();
  if (!page) {
    const pages = stagehand.context.pages();
    page = pages[0];
  }
  if (!page) throw new Error('No active browser page — navigate first');
  return page;
}

export function resolveStagehandModelName(): string {
  const fromEnv = process.env.STAGEHAND_MODEL?.trim();
  if (fromEnv) return fromEnv;
  return 'anthropic/claude-sonnet-4-6';
}

/**
 * Return an existing {@link BrowserSession} for this chat session or launch one.
 */
export async function getOrCreateBrowserSessionForChat(
  chatSessionId: string,
  extraOpts: BrowserSessionOptions = {},
): Promise<BrowserSession> {
  const existing = getBrowserSession(chatSessionId);
  if (existing) return existing;
  return launchBrowserSession({
    id: chatSessionId,
    model: extraOpts.model ?? resolveStagehandModelName(),
    ...extraOpts,
  });
}

function result(op: BrowserToolOp, ok: boolean, data?: unknown, error?: string): BrowserToolResult {
  const r: BrowserToolResult = { ok, op };
  if (data !== undefined) r.data = data;
  if (error !== undefined) r.error = error;
  return r;
}

export async function browserNavigate(stagehand: V3, url: string): Promise<BrowserToolResult> {
  const u = url.trim();
  if (!u) return result('navigate', false, undefined, 'url is required');
  try {
    const page = getActivePage(stagehand);
    const res = await page.goto(u, { waitUntil: 'load', timeoutMs: 30_000 });
    void res;
    return result('navigate', true, { url: page.url() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('navigate', false, undefined, msg);
  }
}

export async function browserClick(stagehand: V3, target: string): Promise<BrowserToolResult> {
  const t = target.trim();
  if (!t) return result('click', false, undefined, 'target is required');
  try {
    if (looksLikeSelectorTarget(t)) {
      const page = getActivePage(stagehand);
      await page.locator(t).click();
      return result('click', true, { method: 'locator' });
    }
    await stagehand.act(`Click ${t}`);
    return result('click', true, { method: 'act' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('click', false, undefined, msg);
  }
}

export async function browserType(
  stagehand: V3,
  target: string,
  text: string,
): Promise<BrowserToolResult> {
  const t = target.trim();
  if (!t) return result('type', false, undefined, 'target is required');
  if (text === undefined) return result('type', false, undefined, 'text is required');
  try {
    if (looksLikeSelectorTarget(t)) {
      const page = getActivePage(stagehand);
      await page.locator(t).fill(String(text));
      return result('type', true, { method: 'locator' });
    }
    const escaped = JSON.stringify(String(text));
    await stagehand.act(`Type ${escaped} into ${t}`);
    return result('type', true, { method: 'act' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('type', false, undefined, msg);
  }
}

export async function browserExtract(
  stagehand: V3,
  instruction?: string,
  schema?: Record<string, unknown>,
): Promise<BrowserToolResult> {
  try {
    if (schema && typeof schema === 'object' && instruction?.trim()) {
      const zodSchema = jsonSchemaToZod(schema as unknown as JsonSchema);
      const data = await stagehand.extract(instruction.trim(), zodSchema);
      return result('extract', true, data);
    }
    if (instruction?.trim()) {
      const data = await stagehand.extract(instruction.trim());
      return result('extract', true, data);
    }
    const data = await stagehand.extract();
    return result('extract', true, data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('extract', false, undefined, msg);
  }
}

export async function browserScreenshot(stagehand: V3): Promise<BrowserToolResult> {
  try {
    const page = getActivePage(stagehand);
    const buf = await page.screenshot({ type: 'png' });
    const b64 = Buffer.from(buf).toString('base64');
    return { ok: true, op: 'screenshot', data: { mime: 'image/png' }, imageBase64: b64 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('screenshot', false, undefined, msg);
  }
}

export async function browserScroll(stagehand: V3, direction: string): Promise<BrowserToolResult> {
  const d = direction.trim().toLowerCase();
  if (!d)
    return result('scroll', false, undefined, 'direction is required (up, down, top, bottom)');
  try {
    const page = getActivePage(stagehand);
    if (d === 'top') {
      await page.evaluate('window.scrollTo(0, 0)');
    } else if (d === 'bottom') {
      await page.evaluate(
        `window.scrollTo(0, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight))`,
      );
    } else if (d === 'up') {
      await page.scroll(0, 0, 0, -SCROLL_DELTA_PX);
    } else if (d === 'down') {
      await page.scroll(0, 0, 0, SCROLL_DELTA_PX);
    } else {
      return result(
        'scroll',
        false,
        undefined,
        `Unknown direction "${direction}" — use up, down, top, or bottom`,
      );
    }
    return result('scroll', true, { direction: d });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('scroll', false, undefined, msg);
  }
}

export async function browserBack(stagehand: V3): Promise<BrowserToolResult> {
  try {
    const page = getActivePage(stagehand);
    await page.goBack({ waitUntil: 'load', timeoutMs: 30_000 });
    return result('back', true, { url: page.url() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('back', false, undefined, msg);
  }
}

export async function browserForward(stagehand: V3): Promise<BrowserToolResult> {
  try {
    const page = getActivePage(stagehand);
    await page.goForward({ waitUntil: 'load', timeoutMs: 30_000 });
    return result('forward', true, { url: page.url() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('forward', false, undefined, msg);
  }
}

export async function browserWaitFixed(
  stagehand: V3,
  condition: string,
): Promise<BrowserToolResult> {
  const c = condition.trim();
  if (!c) return result('wait', false, undefined, 'condition is required');
  try {
    const page = getActivePage(stagehand);
    const lower = c.toLowerCase();
    if (lower === 'networkidle' || lower === 'network_idle' || lower === 'network-idle') {
      await page.waitForLoadState('networkidle', 30_000);
      return result('wait', true, { kind: 'networkidle' });
    }
    if (lower === 'load') {
      await page.waitForLoadState('load', 30_000);
      return result('wait', true, { kind: 'load' });
    }
    if (lower === 'domcontentloaded' || lower === 'dom') {
      await page.waitForLoadState('domcontentloaded', 30_000);
      return result('wait', true, { kind: 'domcontentloaded' });
    }
    const selPrefix = /^selector:\s*/i.exec(c);
    const selector = selPrefix ? c.slice(selPrefix[0].length).trim() : c;
    await page.waitForSelector(selector, { state: 'visible', timeout: 30_000, pierceShadow: true });
    return result('wait', true, { kind: 'selector', selector });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('wait', false, undefined, msg);
  }
}

export async function browserReadPage(stagehand: V3): Promise<BrowserToolResult> {
  try {
    const page = getActivePage(stagehand);
    const text = await page.evaluate(`(function(){
      const b=document.body;
      if(!b) return '';
      return b.innerText || b.textContent || '';
    })()`);
    const s = typeof text === 'string' ? text : String(text ?? '');
    return result('read_page', true, { text: s.slice(0, 800_000) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('read_page', false, undefined, msg);
  }
}

/**
 * Run one browser tool from a parsed ReAct action. Injects markdown for the model.
 */
export async function runBrowserReActStep(
  chatSessionId: string,
  input: BrowserReActActionInput,
): Promise<{ markdown: string; hostExit: number; hostDetail?: string }> {
  const opRaw = typeof input.op === 'string' ? input.op.trim() : '';
  if (!opRaw || !VALID_BROWSER_OPS.has(opRaw)) {
    return {
      markdown: `## Browser tool error\nUnsupported or missing op "${opRaw}"`,
      hostExit: 1,
      hostDetail: 'bad_op',
    };
  }
  const op = opRaw as BrowserToolOp;
  let session: BrowserSession;
  try {
    session = await getOrCreateBrowserSessionForChat(chatSessionId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      markdown: `## Browser tool error\nFailed to open browser session: ${msg}`,
      hostExit: 1,
      hostDetail: 'launch_failed',
    };
  }
  const sh = asV3(session.stagehand);

  const fmt = (r: BrowserToolResult, title: string) => {
    const lines = [`## ${title}`, '', '```json', JSON.stringify(r, null, 2), '```'];
    if (r.ok && r.imageBase64) {
      lines.push('', `![screenshot](data:image/png;base64,${r.imageBase64})`);
    }
    return lines.join('\n');
  };

  try {
    switch (op) {
      case 'close': {
        const closed = await closeBrowserSession(chatSessionId);
        const r = result('close', true, { closed });
        return { markdown: fmt(r, 'Browser: close'), hostExit: 0, hostDetail: 'close' };
      }
      case 'navigate': {
        const r = await browserNavigate(sh, input.url ?? '');
        return {
          markdown: fmt(r, 'Browser: navigate'),
          hostExit: r.ok ? 0 : 1,
          hostDetail: r.ok ? input.url?.slice(0, 120) : r.error,
        };
      }
      case 'click': {
        const r = await browserClick(sh, input.target ?? '');
        return {
          markdown: fmt(r, 'Browser: click'),
          hostExit: r.ok ? 0 : 1,
          hostDetail: r.ok ? (r.data as { method?: string })?.method : r.error,
        };
      }
      case 'type': {
        const r = await browserType(sh, input.target ?? '', input.text ?? '');
        return {
          markdown: fmt(r, 'Browser: type'),
          hostExit: r.ok ? 0 : 1,
          hostDetail: r.ok ? (r.data as { method?: string })?.method : r.error,
        };
      }
      case 'extract': {
        const r = await browserExtract(sh, input.instruction, input.schema);
        return {
          markdown: fmt(r, 'Browser: extract'),
          hostExit: r.ok ? 0 : 1,
          hostDetail: r.ok ? 'extract' : r.error,
        };
      }
      case 'screenshot': {
        const r = await browserScreenshot(sh);
        const { imageBase64, ...rest } = r;
        // Omit huge base64 from JSON block — attach as image line only
        const lean = { ...rest, imageBase64: r.imageBase64 ? '<omitted>' : undefined };
        const lines = [
          '## Browser: screenshot',
          '',
          '```json',
          JSON.stringify(lean, null, 2),
          '```',
        ];
        if (r.ok && imageBase64) {
          lines.push('', `![screenshot](data:image/png;base64,${imageBase64})`);
        }
        return {
          markdown: lines.join('\n'),
          hostExit: r.ok ? 0 : 1,
          hostDetail: r.ok ? 'screenshot' : r.error,
        };
      }
      case 'scroll': {
        const r = await browserScroll(sh, input.direction ?? '');
        return {
          markdown: fmt(r, 'Browser: scroll'),
          hostExit: r.ok ? 0 : 1,
          hostDetail: r.ok ? input.direction : r.error,
        };
      }
      case 'back': {
        const r = await browserBack(sh);
        return {
          markdown: fmt(r, 'Browser: back'),
          hostExit: r.ok ? 0 : 1,
          hostDetail: r.ok ? (r.data as { url?: string } | undefined)?.url : r.error,
        };
      }
      case 'forward': {
        const r = await browserForward(sh);
        return {
          markdown: fmt(r, 'Browser: forward'),
          hostExit: r.ok ? 0 : 1,
          hostDetail: r.ok ? (r.data as { url?: string } | undefined)?.url : r.error,
        };
      }
      case 'wait': {
        const r = await browserWaitFixed(sh, input.condition ?? '');
        return {
          markdown: fmt(r, 'Browser: wait'),
          hostExit: r.ok ? 0 : 1,
          hostDetail: r.ok ? (r.data as { kind?: string } | undefined)?.kind : r.error,
        };
      }
      case 'read_page': {
        const r = await browserReadPage(sh);
        const body = r.data as { text?: string } | undefined;
        const pageText = body?.text ?? '';
        if (!r.ok) {
          return {
            markdown: fmt(r, 'Browser: read_page'),
            hostExit: 1,
            hostDetail: r.error,
          };
        }
        const maxShow = 24_000;
        const fullLen = pageText.length;
        const snippet =
          fullLen > maxShow
            ? `${pageText.slice(0, maxShow)}\n\n… [truncated, ${fullLen} chars total]`
            : pageText;
        const lean = {
          ok: true,
          op: 'read_page' as const,
          data: { text: snippet, totalChars: fullLen },
        };
        const lines = [
          '## Browser: read_page',
          '',
          '```json',
          JSON.stringify(lean, null, 2),
          '```',
        ];
        return {
          markdown: lines.join('\n'),
          hostExit: 0,
          hostDetail: `chars:${fullLen}`,
        };
      }
      default: {
        return {
          markdown: `## Browser tool error\nUnsupported op`,
          hostExit: 1,
          hostDetail: 'bad_op',
        };
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      markdown: `## Browser tool error\n${msg}`,
      hostExit: 1,
      hostDetail: 'threw',
    };
  }
}
