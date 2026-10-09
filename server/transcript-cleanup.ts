/**
 * Speech-to-text models (Whisper in particular) fall into decoding loops on
 * quiet or noisy audio and emit the same phrase dozens of times. A real
 * speaker almost never says an identical multi-word phrase three times in a
 * row, so a run like that is treated as a loop and reduced to one copy.
 * Single words need a longer run before they count ("no, no, no" is speech).
 */

const MAX_PHRASE_TOKENS = 40;
const MIN_PHRASE_REPEATS = 3;
const MIN_WORD_REPEATS = 5;

function normalizeToken(t: string): string {
  return t.toLowerCase().replace(/[.,!?;:…"'«»“”]+$/u, '');
}

function runLength(norm: string[], start: number, n: number): number {
  let count = 1;
  for (let next = start + n; next + n <= norm.length; next += n) {
    for (let k = 0; k < n; k++) {
      if (norm[start + k] !== norm[next + k]) return count;
    }
    count++;
  }
  return count;
}

/**
 * Removes looped repeats by cutting spans out of the original string, so
 * everything outside a loop (paragraph breaks, spacing) is returned as-is.
 */
export function collapseRepeatedPhrases(text: string): string {
  const tokens = Array.from(text.matchAll(/\S+/g), (m) => ({
    start: m.index,
    end: m.index + m[0].length,
  }));
  const norm = tokens.map((t) => normalizeToken(text.slice(t.start, t.end)));
  // Each cut runs from the end of the kept first copy to the end of the run,
  // so the whitespace that followed the loop stays in place.
  const cuts: Array<[number, number]> = [];
  let i = 0;
  while (i < tokens.length) {
    let advance = 1;
    const maxN = Math.min(MAX_PHRASE_TOKENS, Math.floor((tokens.length - i) / MIN_PHRASE_REPEATS));
    // Shortest period first: a run of a two-sentence block also matches at
    // twice its period, and that match would keep two copies.
    for (let n = 1; n <= maxN; n++) {
      const reps = runLength(norm, i, n);
      if (reps >= (n === 1 ? MIN_WORD_REPEATS : MIN_PHRASE_REPEATS)) {
        cuts.push([tokens[i + n - 1].end, tokens[i + n * reps - 1].end]);
        advance = n * reps;
        break;
      }
    }
    i += advance;
  }
  if (cuts.length === 0) return text;
  let out = '';
  let pos = 0;
  for (const [from, to] of cuts) {
    out += text.slice(pos, from);
    pos = to;
  }
  return out + text.slice(pos);
}
