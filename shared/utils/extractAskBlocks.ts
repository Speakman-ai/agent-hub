export interface AskQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskQuestionOption[];
}

export interface AskBlock {
  askId: string;
  questions: AskQuestion[];
}

export interface AskExtractionResult {
  strippedText: string;
  asks: AskBlock[];
}

const ASK_FENCE_RE = /```agenthub:ask\s*\n?([\s\S]*?)\n?```/g;
const ASK_XML_RE = /<agenthub:ask>\s*([\s\S]*?)\s*<\/agenthub:ask>/gi;
const ASK_INLINE_JSON_RE = /(?:<agenthub:ask>|agenthub:ask)\s*(\{[\s\S]*?\})\s*<\/agenthub:ask>/gi;

/** The picker stacks questions vertically; more than this is a runaway payload. */
const MAX_QUESTIONS = 4;
/** Option rows are a plain vertical list, so the UI tolerates more than the documented 4. */
const MAX_OPTIONS = 8;

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

interface RawQuestionItem {
  question?: string;
  prompt?: string;
  label?: string;
  title?: string;
  header?: string;
  id?: string;
  multiSelect?: boolean;
  multi_select?: boolean;
  multiple?: boolean;
  options?: unknown;
  choices?: unknown;
  answers?: unknown;
  items?: unknown;
  values?: unknown;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

function resolveOptionList(raw: RawQuestionItem): unknown[] | null {
  for (const candidate of [raw.options, raw.choices, raw.answers, raw.items, raw.values]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}

function normalizeOption(opt: unknown): AskQuestionOption | null {
  // Models routinely shorten an option to a bare string ("options": ["Yes","No"]).
  if (typeof opt === 'string') {
    const label = opt.trim();
    return label ? { label, description: '' } : null;
  }
  if (!opt || typeof opt !== 'object') return null;
  const o = opt as {
    label?: string;
    value?: string;
    name?: string;
    title?: string;
    text?: string;
    description?: string;
    detail?: string;
    default?: boolean;
    preview?: string;
  };
  const labelRaw = firstString(o.label, o.value, o.name, o.title, o.text);
  if (!labelRaw) return null;
  const label = labelRaw.trim();
  if (!label) return null;
  const description =
    firstString(o.description, o.detail) ?? (o.default === true ? 'Recommended default' : '');
  const preview = typeof o.preview === 'string' ? o.preview : undefined;
  return preview ? { label, description, preview } : { label, description };
}

function normalizeQuestionItem(item: unknown): AskQuestion | null {
  if (!item || typeof item !== 'object') return null;
  const raw = item as RawQuestionItem;

  const question = firstString(raw.question, raw.prompt, raw.label, raw.title);
  if (!question) return null;

  const headerRaw = firstString(raw.header, raw.id)?.trim() ?? '';
  const header = (headerRaw || question.replace(/\s+/g, ' ').trim() || 'Question').slice(0, 12);
  const multiSelect =
    raw.multiSelect === true || raw.multi_select === true || raw.multiple === true;
  const options = resolveOptionList(raw);
  if (!options) return null;

  const validOptions: AskQuestionOption[] = [];
  const seenLabels = new Set<string>();
  for (const opt of options) {
    const normalized = normalizeOption(opt);
    if (!normalized) continue;
    // Selection state and React keys are label-addressed, so a duplicate label
    // would make two rows toggle as one.
    if (seenLabels.has(normalized.label)) continue;
    seenLabels.add(normalized.label);
    validOptions.push(normalized);
    if (validOptions.length >= MAX_OPTIONS) break;
  }

  if (validOptions.length < 1) return null;

  return { question, header, multiSelect, options: validOptions };
}

function resolveQuestionList(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) {
    return parsed.length > 0 ? parsed.slice(0, MAX_QUESTIONS) : null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as { questions?: unknown };
  if (Array.isArray(obj.questions)) {
    return obj.questions.length > 0 ? obj.questions.slice(0, MAX_QUESTIONS) : null;
  }
  // Flat single-question envelope — normalizeQuestionItem rejects it if the
  // object is some other `agenthub:*` payload that happens to be JSON.
  return [parsed];
}

function resolveAskId(parsed: unknown, raw: string): string {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const askId = (parsed as { askId?: string }).askId;
    if (typeof askId === 'string') {
      const id = askId.trim();
      if (id) return id;
    }
  }
  return 'ask-' + simpleHash(raw);
}

/**
 * Drop commas that sit directly before a closing bracket. String and escape
 * state is tracked so only *structural* commas go: a run-of-the-mill
 * `"preview": "x,}"` is field content, and rewriting it silently changes what
 * the user sees on the option row.
 */
function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

/**
 * JSON.parse with the repairs that make the difference between a rendered
 * picker and a wall of raw JSON in chat: trailing commas, and prose wrapped
 * around the payload inside the fence.
 */
function parseAskJson(raw: string): unknown | null {
  const attempts = [raw, stripTrailingCommas(raw)];

  const firstBracket = raw.search(/[[{]/);
  if (firstBracket > 0) {
    const lastBracket = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'));
    if (lastBracket > firstBracket) {
      const sliced = raw.slice(firstBracket, lastBracket + 1);
      attempts.push(sliced, stripTrailingCommas(sliced));
    }
  }

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      /* try the next repair */
    }
  }
  return null;
}

export function parseAskEnvelope(raw: string): AskBlock | null {
  const parsed = parseAskJson(raw);
  if (parsed === null) return null;

  const list = resolveQuestionList(parsed);
  if (!list) return null;

  const out: AskQuestion[] = [];
  for (const item of list) {
    const normalized = normalizeQuestionItem(item);
    if (normalized) out.push(normalized);
  }
  if (out.length === 0) return null;

  return { askId: resolveAskId(parsed, raw), questions: out };
}

export function parseAskPayload(raw: string): AskQuestion[] | null {
  return parseAskEnvelope(raw)?.questions ?? null;
}

// ─── Fence scanning ────────────────────────────────────────────────────
//
// A regex alone cannot find the end of an ask fence: a `preview` string may
// itself contain a "```" run, and models open the block with anything from
// ` ```agenthub:ask ` to ` ~~~json agenthub:ask `. One line-based pass finds
// the real fence boundaries and, in the same walk, the bodies of *non-ask*
// fences, so a documented example inside ```text is never turned into a live
// picker.

interface FenceLine {
  indent: string;
  fence: string;
  rest: string;
}

/** Fence opener / closer line (CommonMark-style: ≤3 spaces indent, 3+ ` or ~). */
function parseFenceLine(line: string): FenceLine | null {
  // Splitting on '\n' leaves the CR of every CRLF line behind, and `.` never
  // matches CR — so the pattern below fails on *every* fence line of a CRLF
  // document, opener and closer alike, and the block renders raw.
  const m = line.replace(/\r+$/, '').match(/^([ \t]{0,3})([`~]{3,})(.*)$/);
  if (!m || m[1].length > 3) return null;
  return { indent: m[1], fence: m[2], rest: m[3] ?? '' };
}

function isClosingFenceLine(fi: FenceLine, fenceChar: '`' | '~', openLen: number): boolean {
  if (fi.fence[0] !== fenceChar) return false;
  if (fi.fence.length < openLen) return false;
  return /^[ \t]*$/.test(fi.rest);
}

const ASK_TOKEN = 'agenthub:ask';

/**
 * True when a fence info string opens an `agenthub:ask` block. Accepts the
 * token anywhere in the info string (models write ```json agenthub:ask), and
 * never matches the `agenthub:ask:answer` fence the picker itself emits.
 *
 * Both edges of the token are checked. Without a right-hand boundary,
 * ```agenthub:asking / ```agenthub:ask-preview would open a live picker and
 * their body would be stripped out of the transcript.
 */
function askTokenEnd(info: string): number {
  const lower = info.toLowerCase();
  for (let idx = lower.indexOf(ASK_TOKEN); idx !== -1; idx = lower.indexOf(ASK_TOKEN, idx + 1)) {
    const end = idx + ASK_TOKEN.length;
    const before = lower.slice(0, idx);
    const after = lower.slice(end);
    // Guard against `x-agenthub:ask` style prefixes.
    if (before !== '' && !/[\s`~]$/.test(before)) continue;
    // End of the info string, whitespace, or the start of a same-line payload.
    // `:` is what rules out `agenthub:ask:answer`.
    if (after === '' || /^[\s{[]/.test(after)) return end;
  }
  return -1;
}

export function isAskFenceInfo(rest: string): boolean {
  return askTokenEnd(rest) !== -1;
}

interface ScannedAskFence {
  payload: string;
  start: number;
  end: number;
}

export interface FenceScan {
  askFences: ScannedAskFence[];
  lockedBodies: Array<{ start: number; end: number }>;
}

/**
 * Index just past the balanced JSON value starting at/after `from`, tracking
 * string and escape state, or -1 if there isn't one. A "```" run inside a
 * `preview` string is ordinary string content to this walk.
 */
function jsonValueEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '{' && text[i] !== '[') return -1;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === '{' || c === '[') {
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * Index of the closing delimiter of a whole-block-on-one-line ask fence, or -1.
 *
 * The first `closeMarker` in the line is not necessarily the delimiter — an
 * option `preview` may hold one — so the payload's JSON structure decides where
 * it ends. If the payload is not balanced JSON, fall back to the first
 * candidate whose preceding text parses as an ask, then to the first candidate
 * at all (which parses nowhere and leaves the block raw, as before).
 */
function sameLineCloseIndex(rest: string, payloadStart: number, closeMarker: string): number {
  const structural = jsonValueEnd(rest, payloadStart);
  if (structural !== -1) {
    const idx = rest.indexOf(closeMarker, structural);
    if (idx !== -1) return idx;
  }

  let first = -1;
  for (
    let idx = rest.indexOf(closeMarker, payloadStart);
    idx !== -1;
    idx = rest.indexOf(closeMarker, idx + 1)
  ) {
    if (first === -1) first = idx;
    if (parseAskEnvelope(rest.slice(payloadStart, idx).trim())) return idx;
  }
  return first;
}

/**
 * Single pass over `text` collecting complete `agenthub:ask` fenced blocks and
 * the half-open `[start, end)` body ranges of every other fenced block.
 */
export function scanFences(text: string): FenceScan {
  const askFences: ScannedAskFence[] = [];
  const lockedBodies: Array<{ start: number; end: number }> = [];
  const lines = text.split('\n');
  const n = lines.length;

  type Mode =
    | { k: 'out' }
    | { k: 'locked'; ch: '`' | '~'; openLen: number; contentStart: number }
    | { k: 'ask'; ch: '`' | '~'; openLen: number; blockStart: number; bodyStart: number };

  let mode: Mode = { k: 'out' };
  let offset = 0;

  for (let i = 0; i < n; i++) {
    const line = lines[i];
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    offset = lineEnd + (i < n - 1 ? 1 : 0);

    const fi = parseFenceLine(line);
    if (!fi) continue;

    const ch = fi.fence[0] as '`' | '~';
    const openLen = fi.fence.length;

    if (mode.k === 'locked') {
      if (isClosingFenceLine(fi, mode.ch, mode.openLen)) {
        lockedBodies.push({ start: mode.contentStart, end: lineStart });
        mode = { k: 'out' };
      }
      continue;
    }

    if (mode.k === 'ask') {
      if (isClosingFenceLine(fi, mode.ch, mode.openLen)) {
        askFences.push({
          payload: text.slice(mode.bodyStart, lineStart),
          start: mode.blockStart,
          end: lineEnd,
        });
        mode = { k: 'out' };
      }
      continue;
    }

    // Outside any fence — this line opens `agenthub:ask` or a generic block.
    const payloadStart = askTokenEnd(fi.rest);
    if (payloadStart !== -1) {
      const closeMarker = ch.repeat(openLen);
      const closeIdx = sameLineCloseIndex(fi.rest, payloadStart, closeMarker);
      if (closeIdx >= 0) {
        // Whole block on one line: ```agenthub:ask {json}```
        askFences.push({
          payload: fi.rest.slice(payloadStart, closeIdx),
          start: lineStart,
          end: lineStart + fi.indent.length + fi.fence.length + closeIdx + openLen,
        });
        continue;
      }
      mode = {
        k: 'ask',
        ch,
        openLen,
        blockStart: lineStart,
        bodyStart: Math.min(lineEnd + 1, text.length),
      };
    } else {
      mode = { k: 'locked', ch, openLen, contentStart: Math.min(lineEnd + 1, text.length) };
    }
  }

  if (mode.k === 'locked') {
    lockedBodies.push({ start: mode.contentStart, end: text.length });
  }
  // An unterminated ask fence is a still-streaming block — leave it alone.

  return { askFences, lockedBodies };
}

/**
 * Half-open character ranges `[start, end)` covering the *body* of fenced
 * code blocks whose info string is not `agenthub:ask`. Used so
 * `extractAskBlocks` does not strip documented examples that appear inside
 * ` ```typescript` / ` ```text` / etc., which used to corrupt markdown and
 * break backtick pairing in chat.
 */
export function computeLockedNonAskFenceBodyRanges(
  text: string,
): Array<{ start: number; end: number }> {
  return scanFences(text).lockedBodies;
}

function overlapsRange(
  start: number,
  end: number,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  return ranges.some((r) => start < r.end && end > r.start);
}

function applyReplacements(
  text: string,
  replacements: Array<{ start: number; end: number }>,
): string {
  if (replacements.length === 0) return text;
  let strippedText = text;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { start, end } = replacements[i];
    strippedText = strippedText.slice(0, start) + strippedText.slice(end);
  }
  return strippedText.replace(/\n{3,}/g, '\n\n').trim();
}

interface CollectedAsk {
  ask: AskBlock;
  start: number;
  end: number;
}

function collectAskMatch(
  payload: string,
  start: number,
  end: number,
  lockedBodies: Array<{ start: number; end: number }>,
  collected: CollectedAsk[],
): void {
  const envelope = parseAskEnvelope(payload.trim());
  if (!envelope) return;
  if (overlapsRange(start, end, lockedBodies)) return;
  if (overlapsRange(start, end, collected)) return;
  collected.push({ ask: envelope, start, end });
}

export function extractAskBlocks(
  text: string,
  opts: { lockedBodies?: Array<{ start: number; end: number }> } = {},
): AskExtractionResult {
  if (!text || !text.includes('agenthub:ask')) {
    return { strippedText: text, asks: [] };
  }

  const scan = scanFences(text);
  const lockedBodies = opts.lockedBodies ?? scan.lockedBodies;
  const collected: CollectedAsk[] = [];

  for (const fence of scan.askFences) {
    collectAskMatch(fence.payload, fence.start, fence.end, lockedBodies, collected);
  }

  // The scanner owns fenced blocks; these passes cover the fence-less shapes
  // (XML tags, inline `agenthub:ask {…}</agenthub:ask>`) and any fenced form
  // it did not recognise. Overlap checks keep a block from being taken twice.
  for (const re of [ASK_FENCE_RE, ASK_XML_RE, ASK_INLINE_JSON_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      collectAskMatch(
        match[1],
        match.index,
        match.index + match[0].length,
        lockedBodies,
        collected,
      );
    }
  }

  if (collected.length === 0) {
    return { strippedText: text, asks: [] };
  }

  // Passes run out of document order, and applyReplacements splices from the
  // end — unsorted ranges would corrupt the surrounding prose.
  collected.sort((a, b) => a.start - b.start);

  return {
    strippedText: applyReplacements(
      text,
      collected.map(({ start, end }) => ({ start, end })),
    ),
    asks: collected.map(({ ask }) => ask),
  };
}
