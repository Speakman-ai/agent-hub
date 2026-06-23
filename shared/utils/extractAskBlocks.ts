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
  header?: string;
  id?: string;
  multiSelect?: boolean;
  options?: unknown[];
}

function normalizeQuestionItem(item: unknown): AskQuestion | null {
  if (!item || typeof item !== 'object') return null;
  const raw = item as RawQuestionItem;

  const question =
    typeof raw.question === 'string'
      ? raw.question
      : typeof raw.prompt === 'string'
        ? raw.prompt
        : typeof raw.label === 'string'
          ? raw.label
          : null;
  if (!question) return null;

  const headerRaw =
    typeof raw.header === 'string'
      ? raw.header.trim()
      : typeof raw.id === 'string'
        ? raw.id.trim()
        : '';
  const header = (headerRaw || question.replace(/\s+/g, ' ').trim() || 'Question').slice(0, 12);
  const multiSelect = raw.multiSelect === true;
  const options = Array.isArray(raw.options) ? raw.options : null;
  if (!options) return null;

  const validOptions: AskQuestionOption[] = [];
  for (const opt of options) {
    if (!opt || typeof opt !== 'object') continue;
    const o = opt as {
      label?: string;
      value?: string;
      description?: string;
      default?: boolean;
      preview?: string;
    };
    const label =
      typeof o.label === 'string' ? o.label : typeof o.value === 'string' ? o.value : null;
    if (!label) continue;
    const description =
      typeof o.description === 'string'
        ? o.description
        : o.default === true
          ? 'Recommended default'
          : '';
    const preview = typeof o.preview === 'string' ? o.preview : undefined;
    validOptions.push(preview ? { label, description, preview } : { label, description });
  }

  if (multiSelect) {
    if (validOptions.length < 2) return null;
  } else if (validOptions.length < 1) {
    return null;
  }
  if (validOptions.length > 4) return null;

  return { question, header, multiSelect, options: validOptions };
}

function resolveQuestionList(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) {
    return parsed.length > 0 && parsed.length <= 4 ? parsed : null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as { questions?: unknown[]; question?: string; options?: unknown[] };
  if (Array.isArray(obj.questions)) {
    const q = obj.questions;
    return q.length > 0 && q.length <= 4 ? q : null;
  }
  if (typeof obj.question === 'string' && Array.isArray(obj.options)) {
    return [parsed];
  }
  return null;
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

export function parseAskEnvelope(raw: string): AskBlock | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

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

function askMatchOverlapsLockedBody(
  start: number,
  end: number,
  locked: Array<{ start: number; end: number }>,
): boolean {
  for (const r of locked) {
    if (start < r.end && end > r.start) return true;
  }
  return false;
}

function overlapsExisting(
  start: number,
  end: number,
  replacements: Array<{ start: number; end: number }>,
): boolean {
  return replacements.some((r) => start < r.end && end > r.start);
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

function collectAskMatch(
  text: string,
  payload: string,
  start: number,
  end: number,
  lockedBodies: Array<{ start: number; end: number }>,
  replacements: Array<{ start: number; end: number }>,
  asks: AskBlock[],
): void {
  const trimmed = payload.trim();
  const envelope = parseAskEnvelope(trimmed);
  if (!envelope) return;
  if (askMatchOverlapsLockedBody(start, end, lockedBodies)) return;
  if (overlapsExisting(start, end, replacements)) return;
  asks.push({ askId: envelope.askId, questions: envelope.questions });
  replacements.push({ start, end });
}

export function extractAskBlocks(
  text: string,
  opts: { lockedBodies?: Array<{ start: number; end: number }> } = {},
): AskExtractionResult {
  if (!text || !text.includes('agenthub:ask')) {
    return { strippedText: text, asks: [] };
  }

  const lockedBodies = opts.lockedBodies ?? [];
  const asks: AskBlock[] = [];
  const replacements: Array<{ start: number; end: number }> = [];

  for (const re of [ASK_FENCE_RE, ASK_XML_RE, ASK_INLINE_JSON_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      collectAskMatch(
        text,
        match[1],
        match.index,
        match.index + match[0].length,
        lockedBodies,
        replacements,
        asks,
      );
    }
  }

  if (replacements.length === 0) {
    return { strippedText: text, asks: [] };
  }

  return { strippedText: applyReplacements(text, replacements), asks };
}
