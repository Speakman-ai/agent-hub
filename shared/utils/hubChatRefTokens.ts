/**
 * The one definition of the Agent Hub chat ref token, `@[label](kind:id)`.
 *
 * Every producer (composer, server, agents) and every parser (server
 * re-resolution, chip rendering, editor decode, push previews) goes through
 * this module, so a token one side writes is always a token the other side
 * reads. Change a limit or character rule here and nowhere else.
 */

export type HubChatRefKind = 'user' | 'agent' | 'session' | 'card' | 'ticket' | 'pr';

export const HUB_CHAT_REF_KINDS: readonly HubChatRefKind[] = [
  'user',
  'agent',
  'session',
  'card',
  'ticket',
  'pr',
];

const KIND_SET: ReadonlySet<string> = new Set(HUB_CHAT_REF_KINDS);

/**
 * Longest label a token may carry, counted in characters of the plain label
 * (an escape pair counts once); longer labels are truncated when formatting.
 */
export const HUB_CHAT_REF_MAX_LABEL = 200;
/** Longest target id a token may carry; longer ids cannot be tokenized. */
export const HUB_CHAT_REF_MAX_ID = 200;

const ELLIPSIS = '…';

/**
 * A fresh global matcher for token candidates. A label is a run of
 * backslash-escapes or characters other than `\\`, `]` and line breaks; an
 * id has no `)` or whitespace. Matching is deliberately loose: whether a
 * candidate is a ref is decided by the markdown parse (`parseHubChatRefTokens`).
 * Built per call so no caller shares `lastIndex` state.
 */
export function hubChatRefTokenRegex(): RegExp {
  return new RegExp(
    `@\\[((?:\\\\[^\\r\\n]|[^\\\\\\]\\r\\n]){1,${HUB_CHAT_REF_MAX_LABEL}})\\]\\(([a-z]+):([^)\\s]{1,${HUB_CHAT_REF_MAX_ID}})\\)`,
    'g',
  );
}

/** Every ASCII punctuation character; CommonMark lets each be backslash-escaped. */
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g;
const ESCAPED_PUNCTUATION = /\\([!-/:-@[-`{-~])/g;

/**
 * Markdown source that renders as exactly `text`: every ASCII punctuation
 * character is backslash-escaped, so no emphasis, code span, link bracket,
 * autolink, HTML or entity can form inside it.
 */
export function escapeMarkdownLiteral(text: string): string {
  return text.replace(ASCII_PUNCTUATION, '\\$&');
}

/** Characters that can open or close inline Markdown anywhere in a line. */
const INLINE_MARKUP = /[\\`*_{}[\]()<>&!|~]/g;
/** Block markers that only matter at the start of a line (heading, quote, list, setext, rule). */
const LINE_START_MARKER = /^([ \t]{0,3})([#>+=-]|\d{1,9}(?=[.)]))/;

/**
 * Markdown source for running text that renders as exactly `text` with as
 * few escapes as possible, so it stays readable in the editor and raw body:
 * inline markup characters are escaped, and a block marker is escaped only
 * when the text starts a line (`atLineStart`).
 */
export function escapeMarkdownText(text: string, atLineStart: boolean): string {
  const inline = text.replace(INLINE_MARKUP, '\\$&');
  if (!atLineStart) return inline;
  return inline.replace(LINE_START_MARKER, (_m, indent: string, marker: string) =>
    /\d/.test(marker) ? `${indent}${marker}\\` : `${indent}\\${marker}`,
  );
}

/** True when `index` is at the start of a Markdown line (after at most three spaces of indent). */
export function isAtLineStart(body: string, index: number): boolean {
  const lineStart = body.lastIndexOf('\n', index - 1) + 1;
  return /^[ \t]{0,3}$/.test(body.slice(lineStart, index));
}

/** The plain text a backslash-escaped Markdown literal stands for. */
export function unescapeMarkdownLiteral(text: string): string {
  return text.replace(ESCAPED_PUNCTUATION, '$1');
}

export function isHubChatRefKind(kind: string): kind is HubChatRefKind {
  return KIND_SET.has(kind);
}

export interface HubChatRefToken {
  /** The full token text, as found in the body. */
  raw: string;
  index: number;
  /** The plain label, with the token's Markdown escapes removed. */
  label: string;
  kind: HubChatRefKind;
  targetId: string;
}

/** Half-open `[start, end)` spans of a message that render literally. */
export type CodeRange = readonly [number, number];

/** What the renderer's markdown parser says about a body. */
export interface MarkdownLayout {
  /** Spans shown literally: code blocks (fenced or indented), inline code, raw HTML. */
  code: CodeRange[];
  /** Every link node the parser built, as start offset -> end offset. */
  links: ReadonlyMap<number, number>;
}

/**
 * Parses a body the way the chat renderer does. Build one with
 * `createMarkdownLocator`; every token function takes it, so storage and
 * rendering can only disagree if they are handed different parsers.
 */
export type MarkdownLocator = (body: string) => MarkdownLayout;

/** The slice of an mdast node the locator reads. */
export interface MarkdownNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
}

/**
 * Node types whose text is never a ref: fenced and indented code blocks,
 * inline code, and raw HTML (which the renderer does not turn into links).
 */
const LITERAL_NODE_TYPES: ReadonlySet<string> = new Set(['code', 'inlineCode', 'html']);

/**
 * Builds a locator from a markdown parser. Pass the parser the renderer runs
 * on (`mdast-util-from-markdown` with the GFM extensions, which is what
 * `react-markdown` + `remark-gfm` use), so "is this a live ref?" has one
 * answer everywhere instead of an approximation of Markdown that drifts from
 * it. The parser is injected because `shared/` carries no runtime dependencies.
 */
export function createMarkdownLocator(parse: (body: string) => MarkdownNode): MarkdownLocator {
  return (body) => {
    const code: [number, number][] = [];
    const links = new Map<number, number>();
    const walk = (node: MarkdownNode) => {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (LITERAL_NODE_TYPES.has(node.type)) {
        if (start !== undefined && end !== undefined) code.push([start, end]);
        return;
      }
      if (node.type === 'link' && start !== undefined && end !== undefined) links.set(start, end);
      for (const child of node.children ?? []) walk(child);
    };
    walk(parse(body));
    return { code: code.sort((a, b) => a[0] - b[0]), links };
  };
}

export function inCodeRange(ranges: readonly CodeRange[], index: number): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/** True when the character at `index` is backslash-escaped (an odd run of `\` before it). */
function isEscaped(body: string, index: number): boolean {
  let n = 0;
  while (index - 1 - n >= 0 && body[index - 1 - n] === '\\') n += 1;
  return n % 2 === 1;
}

/**
 * Tokens the renderer shows as refs, in body order. A token is live only when
 * the parser turned its `[label](kind:id)` into a link node with exactly the
 * token's bounds and its `@` is not backslash-escaped. Anything else (code,
 * raw HTML, `\@[bob](user:…)`, a token swallowed by other markup) is literal
 * text: never stored, counted, chipped or rewritten.
 */
export function parseHubChatRefTokens(body: string, locate: MarkdownLocator): HubChatRefToken[] {
  const found = [...body.matchAll(hubChatRefTokenRegex())].filter((m) => isHubChatRefKind(m[2]));
  if (found.length === 0) return [];
  const layout = locate(body);
  const out: HubChatRefToken[] = [];
  for (const m of found) {
    const index = m.index ?? 0;
    const end = index + m[0].length;
    if (layout.links.get(index + 1) !== end) continue;
    if (isEscaped(body, index) || inCodeRange(layout.code, index)) continue;
    out.push({
      raw: m[0],
      index,
      label: unescapeMarkdownLiteral(m[1]),
      kind: m[2] as HubChatRefKind,
      targetId: m[3],
    });
  }
  return out;
}

/**
 * The plain label a token carries: line breaks become spaces, whitespace
 * collapses, and anything past the limit is cut with an ellipsis. Composer
 * display text uses the same function, so the text the user sees always
 * matches what decoding the stored token gives back. Brackets, backslashes
 * and other Markdown characters are kept; the token escapes them.
 */
export function sanitizeHubChatRefLabel(label: string): string {
  const clean = label.replace(/\s+/g, ' ').trim();
  if (clean.length <= HUB_CHAT_REF_MAX_LABEL) return clean;
  return clean.slice(0, HUB_CHAT_REF_MAX_LABEL - ELLIPSIS.length).trimEnd() + ELLIPSIS;
}

/**
 * Characters an id may use so `kind:id` is always a plain link destination:
 * no brackets, parentheses, backslashes, angle brackets, quotes or spaces.
 */
const SAFE_ID = /^[A-Za-z0-9._~:#@+=-]+$/;

export function isValidHubChatRefId(targetId: string): boolean {
  return targetId.length <= HUB_CHAT_REF_MAX_ID && SAFE_ID.test(targetId);
}

/**
 * Builds a token that always parses as one live ref, or null when the id
 * cannot be tokenized. The label is stored as an escaped Markdown literal, so
 * a title like `[Bug] Login \\ broken` or `**x**` cannot change how the link
 * parses, and decodes back to exactly the same plain text. An empty label
 * falls back to the id.
 */
export function formatHubChatRefToken(
  label: string,
  kind: HubChatRefKind,
  targetId: string,
): string | null {
  if (!isHubChatRefKind(kind) || !isValidHubChatRefId(targetId)) return null;
  const clean = sanitizeHubChatRefLabel(label) || sanitizeHubChatRefLabel(targetId);
  return `@[${escapeMarkdownLiteral(clean)}](${kind}:${targetId})`;
}

/** `@` for people and agents, `#` for everything else. */
export function hubChatRefTrigger(kind: HubChatRefKind): '@' | '#' {
  return kind === 'user' || kind === 'agent' ? '@' : '#';
}

/** Readable form of a ref: `@alice`, `#WEB-12`. Uses the token's own label rules. */
export function hubChatRefDisplay(kind: HubChatRefKind, label: string): string {
  return `${hubChatRefTrigger(kind)}${sanitizeHubChatRefLabel(label)}`;
}

/**
 * Plain text as a reader sees it (push, previews): each live token becomes its
 * readable form and Markdown backslash-escapes outside code are removed, so a
 * flattened `VLT\\-1` previews as `VLT-1`. Code keeps its text exactly.
 */
export function hubChatRefsToPlainText(body: string, locate: MarkdownLocator): string {
  const code = locate(body).code;
  const literal = (from: number, to: number) => {
    let out = '';
    let cursor = from;
    for (const [start, end] of code) {
      if (end <= cursor || start >= to) continue;
      out += unescapeMarkdownLiteral(body.slice(cursor, Math.max(cursor, start)));
      out += body.slice(Math.max(cursor, start), Math.min(end, to));
      cursor = Math.min(end, to);
    }
    return out + unescapeMarkdownLiteral(body.slice(cursor, to));
  };
  let out = '';
  let cursor = 0;
  for (const t of parseHubChatRefTokens(body, locate)) {
    out += literal(cursor, t.index) + hubChatRefDisplay(t.kind, t.label);
    cursor = t.index + t.raw.length;
  }
  return out + literal(cursor, body.length);
}
