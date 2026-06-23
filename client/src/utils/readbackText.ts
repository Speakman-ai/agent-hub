// Pure text-processing core for the streaming "readback" (text-to-speech)
// feature. Kept free of React / Web Speech API so it can be unit-tested in
// isolation — the hook (useReadback) owns the speechSynthesis side effects.
//
// The assistant's text streams in cumulatively (each WebSocket `stream` event
// carries the full text-so-far). We want to:
//   1. Only ever speak NEW text (track a consumed-char offset).
//   2. Speak at sentence boundaries so playback isn't choppy / mid-word.
//   3. Never speak into an unfinished code fence (we'd read code aloud, and
//      we don't yet know where it ends).
//   4. Strip code blocks and markdown markup so we read "just the text".

/**
 * Strip markdown / code so the result is clean prose suitable for TTS.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeForSpeech(text: any) {
  if (typeof text !== 'string' || text.length === 0) return '';
  return (
    text
      // Fenced code blocks (balanced ```...```), then any leftover unterminated
      // fence running to the end of the segment.
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/```[\s\S]*$/g, ' ')
      // Inline code spans.
      .replace(/`[^`]*`/g, ' ')
      // Images: drop entirely (alt text is rarely worth reading).
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      // Links: keep the visible label, drop the URL.
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // Heading / list / blockquote line markers.
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      // Emphasis / strikethrough markers (leave the words).
      .replace(/(\*\*|\*|__|_|~~)/g, '')
      // Collapse whitespace.
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .trim()
  );
}

/**
 * Split a cleaned string into speakable sentences. Splits on sentence-ending
 * punctuation followed by whitespace, and on line breaks. Fragments with no
 * letters/digits (lone punctuation, symbols) are dropped so we don't speak
 * "dash" or read a bare bullet.
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text: any) {
  if (typeof text !== 'string' || text.length === 0) return [];
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s: any) => s.trim())
    .filter((s: any) => /[a-z0-9]/i.test(s));
}

/**
 * Find the offset just past the last "safe" sentence boundary in `text`:
 * the last sentence-ending punctuation followed by whitespace, or the last
 * newline. Returns -1 when there is no complete boundary yet.
 * @param {string} text
 * @returns {number}
 */
function lastStableBoundary(text: any) {
  let punct = -1;
  const re = /[.!?]+\s/g;
  while (re.exec(text) !== null) punct = re.lastIndex;
  const nl = text.lastIndexOf('\n');
  const nlBoundary = nl >= 0 ? nl + 1 : -1;
  return Math.max(punct, nlBoundary);
}

/**
 * Given the full cumulative assistant text and how many chars we've already
 * queued for speech, return the next batch of complete sentences to speak and
 * the new consumed offset.
 *
 * @param {string} content  full text-so-far (cumulative)
 * @param {number} consumed chars already queued
 * @param {{ final?: boolean }} [options]  when final, flush everything that
 *   remains (stream ended) rather than holding back the trailing fragment.
 * @returns {{ utterances: string[], consumed: number }}
 */
export function planReadback(content: any, consumed: any = 0, options: any = {}) {
  const { final = false } = options;
  if (typeof content !== 'string') return { utterances: [], consumed };
  const start = Math.max(0, Math.min(consumed, content.length));
  if (content.length <= start && !final) return { utterances: [], consumed: start };

  let stableEnd: any;
  if (final) {
    stableEnd = content.length;
  } else {
    // Don't speak into an unterminated code fence — hold from its start.
    const fenceCount = (content.match(/```/g) || []).length;
    const limit = fenceCount % 2 === 1 ? content.lastIndexOf('```') : content.length;
    const head = content.slice(0, limit);
    const boundary = lastStableBoundary(head);
    stableEnd = boundary > start ? boundary : start;
  }

  if (stableEnd <= start) return { utterances: [], consumed: start };

  const segment = content.slice(start, stableEnd);
  const utterances = splitSentences(sanitizeForSpeech(segment));
  return { utterances, consumed: stableEnd };
}
