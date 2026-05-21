/**
 * Extract `agenthub:ask` pickers from assistant text (fenced, XML, or inline).
 * Shared by server stream-parser and web client event recovery.
 */

const ASK_FENCE_RE = /```agenthub:ask\s*\n?([\s\S]*?)\n?```/g;
const ASK_XML_RE = /<agenthub:ask>\s*([\s\S]*?)\s*<\/agenthub:ask>/gi;
/** `agenthub:ask { ... }</agenthub:ask>` or `<agenthub:ask>{...}</agenthub:ask>` */
const ASK_INLINE_JSON_RE =
  /(?:<agenthub:ask>|agenthub:ask)\s*(\{[\s\S]*?\})\s*<\/agenthub:ask>/gi;

function simpleHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Normalize one question object (canonical or wizard-style with id/label/value).
 * @param {unknown} item
 */
function normalizeQuestionItem(item) {
  if (!item || typeof item !== 'object') return null;

  const question =
    typeof item.question === 'string'
      ? item.question
      : typeof item.prompt === 'string'
        ? item.prompt
        : typeof item.label === 'string'
          ? item.label
          : null;
  if (!question) return null;

  const headerRaw =
    typeof item.header === 'string'
      ? item.header.trim()
      : typeof item.id === 'string'
        ? item.id.trim()
        : '';
  const header = (headerRaw || question.replace(/\s+/g, ' ').trim() || 'Question').slice(0, 12);
  const multiSelect = item.multiSelect === true;
  const options = Array.isArray(item.options) ? item.options : null;
  if (!options) return null;

  const validOptions = [];
  for (const opt of options) {
    if (!opt || typeof opt !== 'object') continue;
    const label =
      typeof opt.label === 'string'
        ? opt.label
        : typeof opt.value === 'string'
          ? opt.value
          : null;
    if (!label) continue;
    const description =
      typeof opt.description === 'string'
        ? opt.description
        : opt.default === true
          ? 'Recommended default'
          : '';
    const preview = typeof opt.preview === 'string' ? opt.preview : undefined;
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

/**
 * @param {unknown} parsed
 * @returns {unknown[] | null}
 */
function resolveQuestionList(parsed) {
  if (Array.isArray(parsed)) {
    return parsed.length > 0 && parsed.length <= 4 ? parsed : null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (Array.isArray(parsed.questions)) {
    const q = parsed.questions;
    return q.length > 0 && q.length <= 4 ? q : null;
  }
  // Flat envelope: { askId?, header, question, options } (common in preview-setup)
  if (typeof parsed.question === 'string' && Array.isArray(parsed.options)) {
    return [parsed];
  }
  return null;
}

/**
 * @param {unknown} parsed
 * @param {string} raw
 */
function resolveAskId(parsed, raw) {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (typeof parsed.askId === 'string') {
      const id = parsed.askId.trim();
      if (id) return id;
    }
  }
  return 'ask-' + simpleHash(raw);
}

/**
 * @param {string} raw
 * @returns {{ askId: string, questions: Array<{ question: string, header: string, multiSelect: boolean, options: Array<{ label: string, description: string, preview?: string }> }> } | null}
 */
export function parseAskEnvelope(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const list = resolveQuestionList(parsed);
  if (!list) return null;

  const out = [];
  for (const item of list) {
    const normalized = normalizeQuestionItem(item);
    if (normalized) out.push(normalized);
  }
  if (out.length === 0) return null;

  return { askId: resolveAskId(parsed, raw), questions: out };
}

/**
 * @param {string} raw
 * @returns {Array<{ question: string, header: string, multiSelect: boolean, options: Array<{ label: string, description: string, preview?: string }> }> | null}
 */
export function parseAskPayload(raw) {
  return parseAskEnvelope(raw)?.questions ?? null;
}

function askMatchOverlapsLockedBody(start, end, locked) {
  for (const r of locked) {
    if (start < r.end && end > r.start) return true;
  }
  return false;
}

function overlapsExisting(start, end, replacements) {
  return replacements.some((r) => start < r.end && end > r.start);
}

function applyReplacements(text, replacements) {
  if (replacements.length === 0) return text;
  let strippedText = text;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { start, end } = replacements[i];
    strippedText = strippedText.slice(0, start) + strippedText.slice(end);
  }
  return strippedText.replace(/\n{3,}/g, '\n\n').trim();
}

function collectAskMatch(text, payload, start, end, lockedBodies, replacements, asks) {
  const trimmed = payload.trim();
  const envelope = parseAskEnvelope(trimmed);
  if (!envelope) return;
  if (askMatchOverlapsLockedBody(start, end, lockedBodies)) return;
  if (overlapsExisting(start, end, replacements)) return;
  asks.push({ askId: envelope.askId, questions: envelope.questions });
  replacements.push({ start, end });
}

/**
 * @param {string} text
 * @param {{ lockedBodies?: Array<{ start: number, end: number }> }} [opts]
 * @returns {{ strippedText: string, asks: Array<{ askId: string, questions: ReturnType<typeof parseAskPayload> }> }}
 */
export function extractAskBlocks(text, opts = {}) {
  if (!text || !text.includes('agenthub:ask')) {
    return { strippedText: text, asks: [] };
  }

  const lockedBodies = opts.lockedBodies ?? [];
  const asks = [];
  const replacements = [];

  for (const re of [ASK_FENCE_RE, ASK_XML_RE, ASK_INLINE_JSON_RE]) {
    re.lastIndex = 0;
    let match;
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
