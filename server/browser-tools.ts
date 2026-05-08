/**
 * browser-tools.ts — High-level browser operations for agent chat sessions.
 *
 * Uses Stagehand (`act`, `extract`, `observe`) for natural-language targets and
 * Stagehand's CDP `Page.locator()` for CSS/XPath-style selectors. One browser
 * per chat session id (see {@link getOrCreateBrowserSessionForChat}).
 */

import { jsonSchemaToZod, type JsonSchema } from '@browserbasehq/stagehand';
import type { V3 } from '@browserbasehq/stagehand';
import { validateBrowserNavigationUrl } from './browser-navigation-url.js';
import { clipUtf8StringToMaxBytes } from './utf8-clip.js';
import {
  getBrowserSession,
  launchBrowserSession,
  closeBrowserSession,
  type BrowserSession,
  type BrowserSessionOptions,
} from './browser.js';

// ─── Types ───────────────────────────────────────────────────────

/** Single source of truth for ReAct `tool: browser` operations (keep in sync with parseReActBlock). */
export const BROWSER_REACT_OPS = [
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
] as const;

export type BrowserToolOp = (typeof BROWSER_REACT_OPS)[number];

export const BROWSER_REACT_OP_SET: ReadonlySet<string> = new Set(BROWSER_REACT_OPS);

/** Max UTF-8 bytes of `data` JSON embedded in ReAct continuation markdown (per tool result). */
export const BROWSER_TOOL_MARKDOWN_DATA_MAX_BYTES = 24_000;

/** Limits Stagehand `jsonSchemaToZod` work from pathological ReAct-supplied schemas. */
export const BROWSER_EXTRACT_SCHEMA_MAX_JSON_BYTES = 24_000;
export const BROWSER_EXTRACT_SCHEMA_MAX_DEPTH = 14;
export const BROWSER_EXTRACT_SCHEMA_MAX_KEYS_PER_NODE = 80;
export const BROWSER_EXTRACT_SCHEMA_MAX_ARRAY_LENGTH = 96;
export const BROWSER_EXTRACT_SCHEMA_MAX_NODES = 400;

/** Max base64 length for screenshot data-URL line in continuation markdown (~562 KiB raw). */
export const BROWSER_SCREENSHOT_BASE64_MAX_CHARS = 750_000;

export interface BrowserToolResult {
  ok: boolean;
  op: BrowserToolOp;
  data?: unknown;
  error?: string;
  /** Present for screenshot op — image base64 (no data: prefix); typically JPEG. */
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

export function shrinkBrowserToolResultForMarkdown(
  r: BrowserToolResult,
  maxDataJsonBytes: number = BROWSER_TOOL_MARKDOWN_DATA_MAX_BYTES,
): BrowserToolResult {
  if (!r.ok || r.data === undefined) return r;
  const ser = JSON.stringify(r.data);
  if (Buffer.byteLength(ser, 'utf-8') <= maxDataJsonBytes) return r;
  return {
    ...r,
    data: {
      _browserToolDataTruncated: true,
      approxOriginalJsonBytes: Buffer.byteLength(ser, 'utf-8'),
      preview: clipUtf8StringToMaxBytes(ser, maxDataJsonBytes),
    },
  };
}

function asV3(stagehand: unknown): V3 {
  return stagehand as V3;
}

type ExtractSchemaWalkState = { nodes: number };

function walkExtractSchemaJson(
  v: unknown,
  depth: number,
  st: ExtractSchemaWalkState,
): { ok: true } | { ok: false; error: string } {
  if (depth > BROWSER_EXTRACT_SCHEMA_MAX_DEPTH) {
    return { ok: false, error: 'extract schema nesting is too deep' };
  }
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return { ok: true };
  }
  if (Array.isArray(v)) {
    st.nodes++;
    if (st.nodes > BROWSER_EXTRACT_SCHEMA_MAX_NODES) {
      return { ok: false, error: 'extract schema is too large (node budget exceeded)' };
    }
    if (v.length > BROWSER_EXTRACT_SCHEMA_MAX_ARRAY_LENGTH) {
      return { ok: false, error: 'extract schema array is too long' };
    }
    for (const item of v) {
      const r = walkExtractSchemaJson(item, depth + 1, st);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if (typeof v === 'object') {
    st.nodes++;
    if (st.nodes > BROWSER_EXTRACT_SCHEMA_MAX_NODES) {
      return { ok: false, error: 'extract schema is too large (node budget exceeded)' };
    }
    const keys = Object.keys(v as object);
    if (keys.length > BROWSER_EXTRACT_SCHEMA_MAX_KEYS_PER_NODE) {
      return { ok: false, error: 'extract schema object has too many keys' };
    }
    for (const k of keys) {
      const r = walkExtractSchemaJson((v as Record<string, unknown>)[k], depth + 1, st);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  return { ok: false, error: 'extract schema has unsupported value type' };
}

/**
 * Reject oversized / pathological JSON Schema objects before `jsonSchemaToZod`.
 * Uses JSON round-trip so the walk cannot chase circular structures.
 */
export function validateBrowserExtractSchema(
  schema: Record<string, unknown>,
): { ok: true; parsed: Record<string, unknown> } | { ok: false; error: string } {
  let ser: string;
  try {
    ser = JSON.stringify(schema);
  } catch {
    return { ok: false, error: 'extract schema must be JSON-serializable' };
  }
  if (Buffer.byteLength(ser, 'utf8') > BROWSER_EXTRACT_SCHEMA_MAX_JSON_BYTES) {
    return {
      ok: false,
      error: `extract schema JSON exceeds ${BROWSER_EXTRACT_SCHEMA_MAX_JSON_BYTES} UTF-8 bytes`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ser);
  } catch {
    return { ok: false, error: 'extract schema failed to parse' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'extract schema JSON must be a non-null object at the root' };
  }
  const st: ExtractSchemaWalkState = { nodes: 0 };
  const w = walkExtractSchemaJson(parsed, 0, st);
  if (!w.ok) return w;
  return { ok: true, parsed: parsed as Record<string, unknown> };
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

/** Minimal CDP session shape (Stagehand Page keeps `mainSession` private). */
type CdpSessionLike = {
  send(method: string, params?: object): Promise<unknown>;
  on(event: string, handler: (params: unknown) => void): void;
  off(event: string, handler: (params: unknown) => void): void;
};

type PageWithMainSession = { mainSession?: CdpSessionLike };

/**
 * Pause main-frame document requests during navigation and apply
 * {@link validateBrowserNavigationUrl} so redirect targets cannot bypass policy.
 * Best-effort: if Fetch cannot be enabled, only post-navigation URL checks apply.
 */
async function withDocumentNavigationUrlPolicy(
  stagehand: V3,
  run: () => Promise<void>,
): Promise<void> {
  const page = getActivePage(stagehand);
  const ms = (page as unknown as PageWithMainSession).mainSession;
  if (!ms?.send || !ms?.on || !ms?.off) {
    await run();
    return;
  }
  const handler = (raw: unknown) => {
    const params = raw as { requestId: string; request: { url: string; resourceType: string } };
    const { requestId, request } = params;
    const continueReq = () => {
      void ms.send('Fetch.continueRequest', { requestId }).catch(() => {});
    };
    if (request.resourceType !== 'Document') {
      continueReq();
      return;
    }
    const next = validateBrowserNavigationUrl(request.url);
    if (!next.ok) {
      void ms
        .send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
        .catch(() => {});
      return;
    }
    continueReq();
  };
  try {
    await ms.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });
    ms.on('Fetch.requestPaused', handler);
    await run();
  } catch {
    await run();
  } finally {
    ms.off('Fetch.requestPaused', handler);
    await ms.send('Fetch.disable').catch(() => {});
  }
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
  const policy = validateBrowserNavigationUrl(u);
  if (!policy.ok) {
    return result('navigate', false, undefined, policy.error);
  }
  try {
    const page = getActivePage(stagehand);
    await withDocumentNavigationUrlPolicy(stagehand, async () => {
      const res = await page.goto(policy.href, { waitUntil: 'load', timeoutMs: 30_000 });
      void res;
    });
    const finalUrl = page.url();
    const landed = validateBrowserNavigationUrl(finalUrl);
    if (!landed.ok) {
      return result(
        'navigate',
        false,
        undefined,
        `Navigation landed on a disallowed URL: ${landed.error}`,
      );
    }
    return result('navigate', true, { url: finalUrl });
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
      const policy = validateBrowserExtractSchema(schema);
      if (!policy.ok) {
        return result('extract', false, undefined, policy.error);
      }
      const zodSchema = jsonSchemaToZod(policy.parsed as unknown as JsonSchema);
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
    const buf = await page.screenshot({ type: 'jpeg', quality: 72 });
    const b64 = Buffer.from(buf).toString('base64');
    if (b64.length > BROWSER_SCREENSHOT_BASE64_MAX_CHARS) {
      return result(
        'screenshot',
        false,
        undefined,
        'Screenshot exceeds maximum encoded size for chat context',
      );
    }
    return { ok: true, op: 'screenshot', data: { mime: 'image/jpeg' }, imageBase64: b64 };
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
    const finalUrl = page.url();
    const landed = validateBrowserNavigationUrl(finalUrl);
    if (!landed.ok) {
      return result(
        'back',
        false,
        undefined,
        `History navigation landed on a disallowed URL: ${landed.error}`,
      );
    }
    return result('back', true, { url: finalUrl });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('back', false, undefined, msg);
  }
}

export async function browserForward(stagehand: V3): Promise<BrowserToolResult> {
  try {
    const page = getActivePage(stagehand);
    await page.goForward({ waitUntil: 'load', timeoutMs: 30_000 });
    const finalUrl = page.url();
    const landed = validateBrowserNavigationUrl(finalUrl);
    if (!landed.ok) {
      return result(
        'forward',
        false,
        undefined,
        `History navigation landed on a disallowed URL: ${landed.error}`,
      );
    }
    return result('forward', true, { url: finalUrl });
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
  if (!opRaw || !BROWSER_REACT_OP_SET.has(opRaw)) {
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
    const display = shrinkBrowserToolResultForMarkdown(r);
    const lines = [`## ${title}`, '', '```json', JSON.stringify(display, null, 2), '```'];
    if (r.ok && r.imageBase64) {
      const mime = (r.data as { mime?: string } | undefined)?.mime ?? 'image/jpeg';
      lines.push('', `![screenshot](data:${mime};base64,${r.imageBase64})`);
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
          const mime = (r.data as { mime?: string } | undefined)?.mime ?? 'image/jpeg';
          lines.push('', `![screenshot](data:${mime};base64,${imageBase64})`);
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
