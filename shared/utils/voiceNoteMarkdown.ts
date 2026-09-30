/**
 * Markdown for dictated notes: a model-written summary followed by the raw
 * transcript folded into a GitHub-style `<details>` block, plus the parsers
 * web and mobile use to render that block as a collapsible section (neither
 * notes renderer passes raw HTML through).
 */

export const VOICE_TRANSCRIPT_LABEL = 'Voice transcript';

/** Keep a transcript from closing the block early; renderers decode the entity back to `<`. */
function neutralizeDetailsTags(text: string): string {
  return text.replace(/<(\/?)(details|summary)\b/gi, '&lt;$1$2');
}

export function buildVoiceNoteMarkdown(input: {
  transcript: string;
  summary?: string | null;
}): string {
  const transcript = neutralizeDetailsTags((input.transcript || '').trim());
  const summary = neutralizeDetailsTags((input.summary || '').trim());
  const details = [
    '<details>',
    `<summary>${VOICE_TRANSCRIPT_LABEL}</summary>`,
    '',
    transcript,
    '',
    '</details>',
  ].join('\n');
  return summary ? `${summary}\n\n${details}` : details;
}

/**
 * Pads a multi-line block so it sits on its own paragraph at `at` in `text`:
 * a blank line separates it from any neighbouring content.
 */
export function padBlockForInsert(text: string, at: number, block: string): string {
  const trimmed = (block || '').trim();
  if (!trimmed) return '';
  const base = text || '';
  const pos = Math.min(Math.max(0, at), base.length);
  const before = base.slice(0, pos);
  const after = base.slice(pos);
  let lead = '';
  if (before.trim().length > 0) {
    const trailingNewlines = (before.match(/\n*$/)?.[0] ?? '').length;
    lead = '\n'.repeat(Math.max(0, 2 - trailingNewlines));
  }
  let trail = '';
  if (after.trim().length > 0) {
    const leadingNewlines = (after.match(/^\n*/)?.[0] ?? '').length;
    trail = '\n'.repeat(Math.max(0, 2 - leadingNewlines));
  }
  return lead + trimmed + trail;
}

const OPENER_RE = /^<details(?:\s[^>]*)?>\s*(?:<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>)?\s*/i;
const CLOSER_RE = /^\s*<\/details>\s*$/i;

/**
 * Parses the start of a `<details>` HTML chunk. Returns the summary label
 * (defaulting to "Details") and any text that followed the opener in the same
 * chunk, or null when `html` is not a details opener.
 */
export function parseDetailsOpener(html: string): { summary: string; rest: string } | null {
  const src = (html || '').trim();
  const m = src.match(OPENER_RE);
  if (!m) return null;
  const summary = (m[1] || '').trim() || 'Details';
  return { summary, rest: src.slice(m[0].length).trim() };
}

export function isDetailsCloser(html: string): boolean {
  return CLOSER_RE.test(html || '');
}

/**
 * Advances CommonMark fence state for one line. `open` is the current opening
 * fence run ('' when outside a fence). A fence closes only on a line holding
 * the same character, at least as many times, and nothing else but spaces.
 * Returns the new state and whether the line was a fence delimiter.
 */
function stepFence(line: string, open: string): { open: string; delimiter: boolean } {
  if (open) {
    const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
    if (close && close[1][0] === open[0] && close[1].length >= open.length) {
      return { open: '', delimiter: true };
    }
    return { open, delimiter: false };
  }
  const opener = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  // A backtick fence's info string may not contain backticks.
  if (!opener || (opener[1][0] === '`' && opener[2].includes('`'))) {
    return { open: '', delimiter: false };
  }
  return { open: opener[1], delimiter: true };
}

export type DetailsSegment =
  | { kind: 'markdown'; text: string }
  | { kind: 'details'; summary: string; body: string };

/**
 * Splits markdown into plain runs and top-level `<details>` blocks. Fenced
 * code is never scanned, and an unclosed `<details>` stays plain markdown.
 */
export function splitDetailsSegments(markdown: string): DetailsSegment[] {
  const lines = (markdown || '').split('\n');
  const segments: DetailsSegment[] = [];
  let plain: string[] = [];
  let fence = '';

  const flushPlain = () => {
    if (plain.join('\n').trim()) segments.push({ kind: 'markdown', text: plain.join('\n') });
    plain = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const outer = stepFence(line, fence);
    if (fence || outer.delimiter) {
      fence = outer.open;
      plain.push(line);
      continue;
    }
    if (!/^\s*<details(?:\s[^>]*)?>/i.test(line)) {
      plain.push(line);
      continue;
    }

    // Opener: the summary may sit on the same line or the next one.
    let header = line.trim();
    let j = i + 1;
    if (!/<\/summary>/i.test(header) && j < lines.length && /^\s*<summary/i.test(lines[j])) {
      header += lines[j].trim();
      j++;
    }
    const opener = parseDetailsOpener(header);
    let depth = 1;
    let innerFence = '';
    let end = -1;
    for (let k = j; k < lines.length; k++) {
      const inner = lines[k];
      const step = stepFence(inner, innerFence);
      const inFence = innerFence !== '' || step.delimiter;
      innerFence = step.open;
      if (inFence) continue;
      if (/^\s*<details(?:\s[^>]*)?>/i.test(inner)) depth++;
      else if (isDetailsCloser(inner) && --depth === 0) {
        end = k;
        break;
      }
    }
    if (!opener || end === -1) {
      plain.push(line);
      continue;
    }
    flushPlain();
    const body = [opener.rest, ...lines.slice(j, end)].join('\n').trim();
    segments.push({ kind: 'details', summary: opener.summary, body });
    i = end;
  }
  flushPlain();
  return segments;
}
