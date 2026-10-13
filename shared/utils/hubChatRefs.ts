/**
 * Mentions and #references in Agent Hub chat, shared by web and mobile.
 *
 * Message bodies store refs as `@[label](kind:id)` (kinds user, agent, session,
 * card, ticket, pr; a PR id is `project#number`). The composer shows the
 * friendlier `@alice` / `#WEB-12` text and keeps a list of the mentions it
 * inserted, then swaps them for tokens on send. Rendering turns tokens into
 * chips whose detail comes from the viewer-scoped resolve endpoint.
 */
import { dailySummaryCardHref, dailySummarySessionHref } from './dailySummaryLinks';
import {
  formatHubChatRefToken,
  hubChatRefDisplay,
  hubChatRefsToPlainText,
  inCodeRange,
  hubChatRefTrigger,
  parseHubChatRefTokens,
  type HubChatRefKind,
  type HubChatRefToken,
  type MarkdownLocator,
} from './hubChatRefTokens';

// The token grammar lives in hubChatRefTokens.ts; re-exported for callers.
export {
  formatHubChatRefToken,
  parseHubChatRefTokens,
  type HubChatRefKind,
  type HubChatRefToken,
  type MarkdownLocator,
};
export const refTrigger = hubChatRefTrigger;
export const refDisplay = hubChatRefDisplay;

export interface HubChatRefSuggestion {
  kind: HubChatRefKind;
  targetId: string;
  label: string;
  detail: string | null;
  projectId: string | null;
}

/** A ref as one viewer may see it (`POST /api/chat/refs/resolve`). */
export interface HubChatResolvedRef {
  kind: HubChatRefKind;
  targetId: string;
  visible: boolean;
  projectId: string | null;
  label: string | null;
  title: string | null;
  status: string | null;
  agentId: string | null;
  number: number | null;
}

/**
 * One mention in the composer: the text the user sees, the token it sends as,
 * and where that text starts. Each occurrence is tracked by position, so two
 * different targets that share a label (two `#Login` tickets) stay distinct.
 */
export interface ComposerMention {
  display: string;
  token: string;
  at: number;
}

/**
 * The `@…` / `#…` word the caret is in, if any. The trigger must start the
 * text or follow whitespace, an opening bracket, a quote or an emphasis
 * marker, so `a@b.com` and `C#` do not open the picker.
 */
export function findMentionQuery(
  text: string,
  caret: number,
  locate: MarkdownLocator,
): { trigger: '@' | '#'; query: string; start: number } | null {
  const before = text.slice(0, caret);
  // `#` queries may carry one inner `#` so `#web#7` (project#number) works.
  // Emphasis and quote marks may precede the trigger (`_@bo`, `**@bo`).
  const m = /(^|[\s([{_*~"'])(?:@([^\s@#]{0,60})|#([^\s@#]{0,60}(?:#[^\s@#]{0,20})?))$/.exec(
    before,
  );
  if (!m) return null;
  const trigger: '@' | '#' = m[2] !== undefined ? '@' : '#';
  const query = m[2] ?? m[3] ?? '';
  const start = before.length - query.length - 1;
  // No picker inside code: a mention there would stay literal text.
  if (inCodeRange(locate(text).code, start)) return null;
  return { trigger, query, start };
}

/** Replaces the `@query` at `start..caret` with `display` plus a space. */
export function insertMentionText(
  text: string,
  start: number,
  caret: number,
  display: string,
): { text: string; caret: number } {
  const after = text.slice(caret);
  const insert = after.startsWith(' ') ? display : `${display} `;
  const next = text.slice(0, start) + insert + after;
  return { text: next, caret: start + insert.length };
}

/**
 * A token delimits itself, so the characters around a mention never decide
 * whether it is one: `_@bob_`, `**@bob**` and `(@bob)` all keep their target.
 * Whether the user meant to keep the mention is decided when they edit (see
 * `reconcileComposerMentions`); here the text just has to still be there.
 */
function isMentionAt(text: string, m: ComposerMention): boolean {
  return m.at >= 0 && text.slice(m.at, m.at + m.display.length) === m.display;
}

/**
 * Characters that turn a mention into a different word when they newly touch
 * it: a letter or digit after (`@bob` -> `@bobby`), or a letter, digit, `@` or
 * `#` before (`x@bob`). Punctuation, spaces and Markdown emphasis markers do
 * not, so `_@bob_`, `(@bob)` and `@bob.` keep their target.
 */
const EXTENDS_AFTER = /^[\p{L}\p{N}]/u;
const EXTENDS_BEFORE = /[\p{L}\p{N}@#]$/u;

/** The full character (surrogate pairs included) just before / after an offset. */
function charBefore(text: string, at: number): string {
  if (at <= 0) return '';
  const code = text.charCodeAt(at - 1);
  return code >= 0xdc00 && code <= 0xdfff && at >= 2 ? text.slice(at - 2, at) : text[at - 1];
}
function charAfter(text: string, at: number): string {
  return at >= text.length ? '' : String.fromCodePoint(text.codePointAt(at) as number);
}

/**
 * Moves mentions through one edit from `prev` to `next`.
 *
 * A mention the edit overlapped is dropped. A mention outside the changed
 * span keeps its target, shifted as needed, unless the edit changed what
 * touches one of its ends and the new neighbour extends it into another word.
 * Judging the resulting text rather than the inserted characters treats
 * every way of joining words the same: typing `by` after `@bob`, deleting the
 * space in `@bob by`, or deleting the space in `x @bob`. Neighbours that were
 * already there (a decoded `_@bob_`) are never re-judged.
 *
 * `caret` (where the edit ended in `next`) decides which occurrence changed
 * when the text alone is ambiguous, e.g. deleting the first of two identical
 * `#Login` mentions.
 */
export function reconcileComposerMentions(
  prev: string,
  next: string,
  mentions: ComposerMention[],
  caret?: number | null,
): ComposerMention[] {
  if (prev === next || mentions.length === 0) return mentions;
  const min = Math.min(prev.length, next.length);
  let suffix = 0;
  while (suffix < min && prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]) {
    suffix += 1;
  }
  if (caret != null && caret >= 0 && caret <= next.length) {
    suffix = Math.min(suffix, next.length - caret);
  }
  let prefix = 0;
  while (prefix < min - suffix && prev[prefix] === next[prefix]) prefix += 1;
  const prevEnd = prev.length - suffix;
  const delta = next.length - prev.length;
  const out: ComposerMention[] = [];
  for (const m of mentions) {
    const end = m.at + m.display.length;
    let at: number;
    if (end <= prefix) at = m.at;
    else if (m.at >= prevEnd) at = m.at + delta;
    else continue;
    const nextEnd = at + m.display.length;
    const before = charBefore(next, at);
    const after = charAfter(next, nextEnd);
    if (before !== charBefore(prev, m.at) && EXTENDS_BEFORE.test(before)) continue;
    if (after !== charAfter(prev, end) && EXTENDS_AFTER.test(after)) continue;
    out.push(at === m.at ? m : { ...m, at });
  }
  return out;
}

/** Adds a just-inserted mention, replacing any stale entry at the same offset. */
export function addComposerMention(
  mentions: ComposerMention[],
  mention: ComposerMention,
): ComposerMention[] {
  return [...mentions.filter((m) => m.at !== mention.at), mention].sort((a, b) => a.at - b.at);
}

/**
 * Swaps each mention for its token at its own offset, keeping only tokens the
 * renderer will show as refs. The encoded text is checked with the same parse
 * the server and renderer use: a mention that would land in code, after a
 * backslash, or anywhere else Markdown would not make it a link is sent as
 * the plain text the user sees, never as a dead token.
 */
export function encodeComposerMentions(
  text: string,
  mentions: ComposerMention[],
  locate: MarkdownLocator,
): string {
  let candidates: ComposerMention[] = [];
  let lastEnd = -1;
  for (const m of [...mentions].sort((a, b) => a.at - b.at)) {
    if (m.at < lastEnd || !isMentionAt(text, m)) continue;
    candidates.push(m);
    lastEnd = m.at + m.display.length;
  }
  // Dropping one token can change how its neighbours parse, so re-check
  // until every token that remains is live.
  for (;;) {
    let out = '';
    let cursor = 0;
    const starts: number[] = [];
    for (const m of candidates) {
      out += text.slice(cursor, m.at);
      starts.push(out.length);
      out += m.token;
      cursor = m.at + m.display.length;
    }
    out += text.slice(cursor);
    if (candidates.length === 0) return out;
    const live = new Set(parseHubChatRefTokens(out, locate).map((t) => t.index));
    const kept = candidates.filter((_, n) => live.has(starts[n]));
    if (kept.length === candidates.length) return out;
    candidates = kept;
  }
}

/** The reverse of `encodeComposerMentions`, for opening a message in the editor. */
export function decodeToComposer(
  body: string,
  locate: MarkdownLocator,
): { text: string; mentions: ComposerMention[] } {
  const mentions: ComposerMention[] = [];
  let text = '';
  let cursor = 0;
  for (const t of parseHubChatRefTokens(body, locate)) {
    const display = refDisplay(t.kind, t.label);
    text += body.slice(cursor, t.index);
    mentions.push({ display, token: t.raw, at: text.length });
    text += display;
    cursor = t.index + t.raw.length;
  }
  return { text: text + body.slice(cursor), mentions };
}

/** Plain-text rendering (push bodies, previews): each token becomes its display. */
export function refsToPlainText(body: string, locate: MarkdownLocator): string {
  return hubChatRefsToPlainText(body, locate);
}

/** The hast/React attribute that marks a rendered link as ref `n` of a message. */
export const HUB_REF_DATA_ATTR = 'data-hubref';

/** The slice of an mdast node `markHubChatRefLinks` reads and edits. */
export interface MarkableNode {
  type: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkableNode[];
  data?: { hProperties?: Record<string, unknown> } & Record<string, unknown>;
}

/**
 * Marks ref links in the renderer's own parse of `body`, without rewriting
 * the source. Rewriting tokens to other Markdown and re-parsing let neighbours
 * change what they became (`!` before a rewritten link made it an image), so
 * the renderer instead parses the original body, the same input the server
 * judges, and this pass finds each live token's link node by its offset.
 * It tags the node with `data-hubref=<n>` (n indexes `tokens`) and drops the
 * token's leading `@` text, which the chip shows itself. Node types never
 * change. Use as a remark plugin body: `() => (tree) => markHubChatRefLinks(tree, tokens)`.
 */
export function markHubChatRefLinks(tree: MarkableNode, tokens: HubChatRefToken[]): void {
  if (tokens.length === 0) return;
  const byLinkStart = new Map<number, number>();
  tokens.forEach((t, n) => byLinkStart.set(t.index + 1, n));
  const visit = (parent: MarkableNode) => {
    const children = parent.children;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const start = child.position?.start.offset;
      const n = child.type === 'link' && start !== undefined ? byLinkStart.get(start) : undefined;
      if (n === undefined) {
        visit(child);
        continue;
      }
      child.data = {
        ...child.data,
        hProperties: { ...child.data?.hProperties, [HUB_REF_DATA_ATTR]: String(n) },
      };
      const prev = children[i - 1];
      if (
        prev?.type === 'text' &&
        prev.position?.end.offset === start &&
        prev.value?.endsWith('@')
      ) {
        prev.value = prev.value.slice(0, -1);
        if (prev.value === '') {
          children.splice(i - 1, 1);
          i -= 1;
        }
      }
    }
  };
  visit(tree);
}

/** The ref index a rendered link was tagged with, or null for an ordinary link. */
export function hubRefIndexFromProps(props: Record<string, unknown>): number | null {
  const raw = props[HUB_REF_DATA_ATTR];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

export function refKey(kind: string, targetId: string): string {
  return `${kind}:${targetId}`;
}

export function pullRequestHref(projectId: string, number: number): string {
  return `/projects/${encodeURIComponent(projectId)}/pulls/${number}`;
}

export function supportTicketHref(projectId: string, ticketId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/support?ticket=${encodeURIComponent(ticketId)}`;
}

/** Deep link for a resolved ref, or null when the viewer cannot open it. */
export function hubChatRefHref(ref: HubChatResolvedRef): string | null {
  if (!ref.visible) return null;
  switch (ref.kind) {
    case 'card':
      return ref.projectId ? dailySummaryCardHref(ref.projectId, ref.targetId) : null;
    case 'session':
      return dailySummarySessionHref(ref.targetId, ref.agentId);
    case 'pr':
      return ref.projectId && ref.number ? pullRequestHref(ref.projectId, ref.number) : null;
    case 'ticket':
      return ref.projectId ? supportTicketHref(ref.projectId, ref.targetId) : null;
    default:
      return null;
  }
}
