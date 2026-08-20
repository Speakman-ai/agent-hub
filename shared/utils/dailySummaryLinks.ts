/**
 * Hub Daily Summary deep links — tickets, sessions, todos, and projects.
 *
 * The generator is instructed to copy these markdown URLs; we also
 * post-process the report so a title mentioned without a link still navigates.
 */

export type ParsedDailySummaryHref =
  | { type: 'card'; projectId: string; cardId: string }
  | { type: 'session'; sessionId: string; agentId: string | null }
  | { type: 'todo' }
  | { type: 'project'; projectId: string };

export interface DailySummaryLinkRef {
  label: string;
  href: string;
}

const SKIP_LABELS = new Set(['today', 'yesterday', 'right now', 'hub', 'todo', 'todos']);

export function dailySummaryCardHref(projectId: string, cardId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/board?card=${encodeURIComponent(cardId)}`;
}

export function dailySummaryProjectHref(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/board`;
}

export function dailySummarySessionHref(sessionId: string, agentId?: string | null): string {
  const path = `/sessions/${encodeURIComponent(sessionId)}`;
  const agent = (agentId || '').trim();
  return agent ? `${path}?agent=${encodeURIComponent(agent)}` : path;
}

export function dailySummaryTodoHref(): string {
  return '/hub/todos';
}

function pathAndQuery(raw: string): { pathname: string; search: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const u = new URL(trimmed);
      return { pathname: u.pathname, search: u.search };
    }
  } catch {
    return null;
  }
  const withoutHash = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  const [pathname, query = ''] = withoutHash.split('?');
  return { pathname, search: query ? `?${query}` : '' };
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseDailySummaryHref(
  href: string | null | undefined,
): ParsedDailySummaryHref | null {
  if (!href) return null;
  const parts = pathAndQuery(href);
  if (!parts) return null;
  const pathname = parts.pathname.replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(
    parts.search.startsWith('?') ? parts.search.slice(1) : parts.search,
  );

  const sessionMatch = /^\/sessions\/([^/]+)$/.exec(pathname);
  if (sessionMatch) {
    const sessionId = decodeSegment(sessionMatch[1]);
    if (!sessionId) return null;
    const agent = params.get('agent');
    return { type: 'session', sessionId, agentId: agent ? decodeSegment(agent) : null };
  }

  if (pathname === '/hub/todos') return { type: 'todo' };

  const boardMatch = /^\/projects\/([^/]+)\/board$/.exec(pathname);
  if (boardMatch) {
    const projectId = decodeSegment(boardMatch[1]);
    if (!projectId) return null;
    const cardId = params.get('card');
    if (cardId) return { type: 'card', projectId, cardId: decodeSegment(cardId) };
    return { type: 'project', projectId };
  }

  return null;
}

export function dispatchDailySummaryHref(
  href: string | null | undefined,
  handlers: {
    onCard?: (projectId: string, cardId: string) => void;
    onSession?: (sessionId: string, agentId: string | null) => void;
    onTodo?: () => void;
    onProject?: (projectId: string) => void;
  },
): boolean {
  const parsed = parseDailySummaryHref(href);
  if (!parsed) return false;
  switch (parsed.type) {
    case 'card':
      handlers.onCard?.(parsed.projectId, parsed.cardId);
      return true;
    case 'session':
      handlers.onSession?.(parsed.sessionId, parsed.agentId);
      return true;
    case 'todo':
      handlers.onTodo?.();
      return true;
    case 'project':
      handlers.onProject?.(parsed.projectId);
      return true;
    default: {
      const _never: never = parsed;
      return _never;
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`]+`/g;
const LINK_RE = /\[[^\]]*]\([^)]*\)/g;

function protect(markdown: string): { text: string; slots: string[] } {
  const slots: string[] = [];
  let text = markdown;
  for (const re of [FENCE_RE, INLINE_CODE_RE, LINK_RE]) {
    text = text.replace(re, (match) => {
      const token = `\uE000${slots.length}\uE000`;
      slots.push(match);
      return token;
    });
  }
  return { text, slots };
}

function restore(text: string, slots: string[]): string {
  return text.replace(/\uE000(\d+)\uE000/g, (_m, idx) => slots[Number(idx)] ?? '');
}

/**
 * Wrap leftover title / id mentions with markdown links. Existing links and
 * code are left alone. Longer labels win so "Fix login timeout" is not
 * eaten by "Fix login".
 */
export function linkifyDailySummaryMarkdown(markdown: string, refs: DailySummaryLinkRef[]): string {
  if (!markdown.trim() || refs.length === 0) return markdown;

  const unique: DailySummaryLinkRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const label = ref.label.trim();
    const href = ref.href.trim();
    if (!label || !href) continue;
    if (SKIP_LABELS.has(label.toLowerCase())) continue;
    const key = `${label.toLowerCase()}::${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ label, href });
  }
  unique.sort((a, b) => b.label.length - a.label.length);

  let current = markdown;
  for (const ref of unique) {
    if (ref.label.length < 3) continue;
    const { text, slots } = protect(current);
    const re = new RegExp(escapeRegExp(ref.label), 'g');
    current = restore(text.replace(re, `[${ref.label}](${ref.href})`), slots);
  }

  const byId = new Map<string, DailySummaryLinkRef>();
  for (const ref of unique) {
    const parsed = parseDailySummaryHref(ref.href);
    if (parsed?.type === 'card') byId.set(parsed.cardId.toLowerCase(), ref);
    if (parsed?.type === 'session') byId.set(parsed.sessionId.toLowerCase(), ref);
  }
  if (byId.size > 0) {
    const { text, slots } = protect(current);
    current = restore(
      text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (id) => {
        const ref = byId.get(id.toLowerCase());
        return ref ? `[${ref.label}](${ref.href})` : id;
      }),
      slots,
    );
  }

  return current;
}
