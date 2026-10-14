/**
 * Pure helpers for the mobile Agent Hub chat screen: turning ref tokens into
 * chips inside the markdown-it renderer, where a chip tap goes, and display
 * strings for the rail.
 */
import {
  isHubChatRefKind,
  type HubChatRefKind,
  type HubChatRefToken,
} from '@shared/utils/hubChatRefTokens';
import type { HubChatResolvedRef } from '@shared/utils/hubChatRefs';

const REF_HREF = /^([a-z]+):(.+)$/;

/** The `kind:id` a rendered link points at, when it is a chat ref scheme. */
export function refFromHref(
  href: string | null | undefined,
): { kind: HubChatRefKind; targetId: string } | null {
  if (!href) return null;
  const m = REF_HREF.exec(href);
  if (!m || !isHubChatRefKind(m[1])) return null;
  let targetId = m[2];
  try {
    targetId = decodeURIComponent(targetId);
  } catch {
    // markdown-it percent-encodes some characters; keep the raw id otherwise.
  }
  return { kind: m[1], targetId };
}

/**
 * Link destinations of live tokens are rewritten to `<scheme>:<n>` before
 * rendering, where n indexes the shared parser's live tokens. The scheme is
 * random per app run, so text a user typed cannot pose as a marked token.
 */
export const HUB_REF_SCHEME = `hubref${Math.random()
  .toString(36)
  .slice(2, 10)
  .replace(/[^a-z]/g, 'x')}`;

/**
 * The body to render, with each live token marked by source occurrence.
 *
 * Chips must appear exactly where the shared parser (the one the server
 * stores refs with) found live tokens. Pairing rendered links with tokens by
 * counting goes wrong whenever the renderer sees a ref-scheme link the shared
 * parser does not count (an escaped token, a reference-style `[alias][x]`
 * whose definition points at `user:...`). So the destination of every live
 * token is replaced, in place, by a marker carrying the token's index. Only
 * the destination text changes; the `@`, brackets and parentheses that decide
 * what Markdown makes of the token are untouched, so no node changes type.
 * Returns the body unchanged when the marker scheme already occurs in it.
 */
export function markLiveTokens(body: string, tokens: HubChatRefToken[]): string {
  if (tokens.length === 0 || body.includes(`${HUB_REF_SCHEME}:`)) return body;
  let out = body;
  for (let n = tokens.length - 1; n >= 0; n--) {
    const t = tokens[n];
    const dest = `${t.kind}:${t.targetId}`;
    const destAt = t.index + t.raw.length - 1 - dest.length;
    if (out.slice(destAt, destAt + dest.length) !== dest) continue;
    out = out.slice(0, destAt) + `${HUB_REF_SCHEME}:${n}` + out.slice(destAt + dest.length);
  }
  return out;
}

/** The live token a rendered link was marked as by `markLiveTokens`, if any. */
export function chipTokenFor(
  href: string | null | undefined,
  tokens: HubChatRefToken[],
): HubChatRefToken | null {
  if (!href || !href.startsWith(`${HUB_REF_SCHEME}:`)) return null;
  const raw = href.slice(HUB_REF_SCHEME.length + 1);
  if (!/^\d+$/.test(raw)) return null;
  return tokens[Number(raw)] ?? null;
}

interface InlineToken {
  type: string;
  content: string;
  attrGet(name: string): string | null;
}

interface CoreState {
  tokens: { type: string; children: unknown[] | null }[];
}

/** The slice of a markdown-it instance the plugin touches (the package ships no types). */
export interface MarkdownItLike {
  core: {
    ruler: {
      before(name: string, rule: string, fn: (state: CoreState) => boolean): void;
    };
  };
}

/**
 * markdown-it plugin: drops the `@` text that leads a marked live token, since
 * the chip shows its own trigger. Only links `markLiveTokens` marked are
 * touched; any other link keeps its text exactly as written.
 */
export function hubChatRefAtPlugin(md: MarkdownItLike): void {
  md.core.ruler.before('text_join', 'hub_chat_ref_at', (state: CoreState) => {
    for (const block of state.tokens) {
      if (block.type !== 'inline' || !block.children) continue;
      const children = block.children as unknown as InlineToken[];
      for (let i = 1; i < children.length; i++) {
        const link = children[i];
        if (link.type !== 'link_open') continue;
        if (!link.attrGet('href')?.startsWith(`${HUB_REF_SCHEME}:`)) continue;
        const prev = children[i - 1];
        if (prev.type === 'text' && prev.content.endsWith('@')) {
          prev.content = prev.content.slice(0, -1);
        }
      }
    }
    return true;
  });
}

/** Where tapping a chip goes on mobile. */
export type HubChatRefTarget =
  | { kind: 'screen'; screen: string; params: Record<string, unknown> }
  | { kind: 'session'; agentId: string; sessionId: string };

/**
 * Mobile peer of `hubChatRefHref`: the screen a visible ref opens, or null
 * when the viewer cannot open it (hidden, people, agents).
 */
export function hubChatRefTarget(ref: HubChatResolvedRef): HubChatRefTarget | null {
  if (!ref.visible) return null;
  switch (ref.kind) {
    case 'card':
      return ref.projectId
        ? {
            kind: 'screen',
            screen: 'Kanban',
            params: { projectId: ref.projectId, cardId: ref.targetId },
          }
        : null;
    case 'session':
      return ref.agentId
        ? { kind: 'session', agentId: ref.agentId, sessionId: ref.targetId }
        : null;
    case 'pr':
      return ref.projectId && ref.number
        ? {
            kind: 'screen',
            screen: 'PullRequests',
            params: { projectId: ref.projectId, prNumber: ref.number },
          }
        : null;
    case 'ticket':
      return ref.projectId
        ? {
            kind: 'screen',
            screen: 'CustomerSupport',
            params: { projectId: ref.projectId, ticketId: ref.targetId },
          }
        : null;
    default:
      return null;
  }
}

/** Badge text, capped the way the drawer caps its other counts. */
export function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count);
}
