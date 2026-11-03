/**
 * `agenthub:forward` — a confirm-then-start card for a new session.
 *
 * Hub and Consult chats emit one of these instead of calling
 * `sessions.sh dispatch` themselves. The client renders the summary, a
 * ship-level dropdown, and a Session forward button. Nothing starts until
 * the person presses it.
 *
 * A block is either a fence or an XML tag wrapped around one JSON object:
 *
 * ```agenthub:forward
 * {"projectId":"app","agentId":"ada","name":"Fix login","summary":"…","prompt":"…","mode":"manual"}
 * ```
 *
 * The prompt may contain code fences inside its JSON string. Extraction
 * walks the object with string-aware braces, so those fences are not the
 * closer. A block with no closer is left in the text (a partial stream).
 */

export const SESSION_FORWARD_MODES = ['manual', 'review', 'push', 'merge', 'consult'] as const;

export type SessionForwardMode = (typeof SESSION_FORWARD_MODES)[number];

/** Ship levels for a dev project. */
export const SESSION_FORWARD_BUILD_MODES: readonly SessionForwardMode[] = [
  'manual',
  'review',
  'push',
  'merge',
];

/** Workflow projects have no build or ship levels, only a consult chat. */
export const SESSION_FORWARD_WORKFLOW_MODES: readonly SessionForwardMode[] = ['consult'];

export const SESSION_FORWARD_MODE_OPTIONS: ReadonlyArray<{
  value: SessionForwardMode;
  label: string;
  description: string;
}> = [
  {
    value: 'manual',
    label: 'Build',
    description: 'Stay in the loop with the agent and ship it yourself',
  },
  {
    value: 'review',
    label: 'Build and Review',
    description: 'Tests and a review run after every turn; you push',
  },
  {
    value: 'push',
    label: 'Build and Push',
    description: 'Build, review, test, and push — no auto-merge',
  },
  {
    value: 'merge',
    label: 'Auto Merge',
    description: 'Build, review, test, push, and auto-merge when it is available',
  },
  {
    value: 'consult',
    label: 'Consult',
    description: 'A chat on that workflow project; nothing is built or shipped',
  },
];

const MAX_PROMPT = 50_000;
const MAX_SUMMARY = 2_000;
const MAX_NAME = 120;

export interface ExtractedForward {
  forwardId: string;
  projectId: string;
  agentId: string;
  name: string;
  summary: string;
  prompt: string;
  mode: SessionForwardMode;
}

export interface ForwardExtractionResult {
  strippedText: string;
  forwards: ExtractedForward[];
}

const OPENER_RE = /(?:```+|~~~+)[^\n]*agenthub:forward(?![\w:-])|<agenthub:forward>/gi;

export function sessionForwardModeLabel(mode: string | null | undefined): string {
  return SESSION_FORWARD_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? 'Build';
}

export function parseSessionForwardMode(value: unknown): SessionForwardMode {
  return typeof value === 'string' && (SESSION_FORWARD_MODES as readonly string[]).includes(value)
    ? (value as SessionForwardMode)
    : 'manual';
}

/**
 * Modes the card offers for its target. `workflow` is null while the project
 * list has not loaded; then a `consult` suggestion is the only hint we have.
 */
export function sessionForwardModesFor(
  workflow: boolean | null | undefined,
  suggested: SessionForwardMode,
): readonly SessionForwardMode[] {
  const isWorkflow = workflow ?? suggested === 'consult';
  return isWorkflow ? SESSION_FORWARD_WORKFLOW_MODES : SESSION_FORWARD_BUILD_MODES;
}

/** The suggested mode when the target allows it, else the target's first mode. */
export function initialSessionForwardMode(
  allowed: readonly SessionForwardMode[],
  suggested: SessionForwardMode,
): SessionForwardMode {
  return allowed.includes(suggested) ? suggested : (allowed[0] ?? 'manual');
}

/**
 * Where a card remembers the session it started. One card occurrence owns one
 * key: the account and server, the chat and message it was posted in, and its
 * position among same-id cards in that message. Asking for the same work in
 * another message or chat gets a fresh card.
 */
export function sessionForwardStorageKey(scope: {
  owner: string;
  sessionId: string | null | undefined;
  messageId: string | number | null | undefined;
  forwardId: string;
  occurrence: number;
}): string | null {
  if (!scope.sessionId || scope.messageId == null || scope.messageId === '') return null;
  return [
    'agenthub.sessionForward',
    scope.owner,
    scope.sessionId,
    String(scope.messageId),
    scope.forwardId,
    String(scope.occurrence),
  ]
    .map((part) => encodeURIComponent(part))
    .join(':');
}

interface ForwardEventLike {
  type?: string;
  forwardId?: unknown;
}

/**
 * Card bookkeeping for one message's event list.
 *
 * A card streams as `assistant_text` partials, then its final frame is lifted
 * into an explicit `session_forward` event with no final text, so the partials
 * are never superseded. `takenByEvent` reports a text-derived card that a later
 * explicit event will render, so the reducer drops the copy. `occurrence`
 * numbers rendered cards per id so two identical requests stay separate.
 */
export function createSessionForwardTracker(events: Array<ForwardEventLike | null | undefined>) {
  const explicit = new Map<string, number[]>();
  events.forEach((event, index) => {
    if (event?.type !== 'session_forward' || typeof event.forwardId !== 'string') return;
    const list = explicit.get(event.forwardId) ?? [];
    list.push(index);
    explicit.set(event.forwardId, list);
  });
  const seen = new Map<string, number>();
  return {
    takenByEvent(forwardId: string, fromIndex: number): boolean {
      const list = explicit.get(forwardId);
      if (!list) return false;
      const at = list.findIndex((index) => index >= fromIndex);
      if (at < 0) return false;
      list.splice(at, 1);
      return true;
    },
    occurrence(forwardId: string): number {
      const next = seen.get(forwardId) ?? 0;
      seen.set(forwardId, next + 1);
      return next;
    },
  };
}

function forwardIdFor(projectId: string, agentId: string, name: string, prompt: string): string {
  const source = `${projectId}\0${agentId}\0${name}\0${prompt}`;
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = (Math.imul(31, hash) + source.charCodeAt(i)) | 0;
  }
  return `fwd-${(hash >>> 0).toString(36)}`;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function normalizeForward(value: unknown): ExtractedForward | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const projectId = typeof row.projectId === 'string' ? row.projectId.trim() : '';
  const agentId = typeof row.agentId === 'string' ? row.agentId.trim() : '';
  const prompt = typeof row.prompt === 'string' ? row.prompt.trim() : '';
  if (!projectId || !agentId || !prompt) return null;
  const summarySource = typeof row.summary === 'string' ? row.summary.trim() : '';
  const summary = clip(summarySource || prompt, MAX_SUMMARY);
  const nameSource = typeof row.name === 'string' ? row.name.trim() : '';
  const name = clip(nameSource || summary.split('\n')[0] || 'New session', MAX_NAME);
  const suppliedId = typeof row.id === 'string' ? row.id.trim() : '';
  const forwardId = /^[A-Za-z0-9_-]{1,80}$/.test(suppliedId)
    ? suppliedId
    : forwardIdFor(projectId, agentId, name, prompt);
  return {
    forwardId,
    projectId,
    agentId,
    name,
    summary,
    prompt: clip(prompt, MAX_PROMPT),
    mode: parseSessionForwardMode(row.mode),
  };
}

/** String-aware `{...}` parse starting at `start`, which must be `{`. */
function parseJsonObject(text: string, start: number): { value: unknown; end: number } | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return { value: JSON.parse(text.slice(start, i + 1)), end: i + 1 };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function consumeCloser(text: string, from: number, kind: 'xml' | 'fence'): number | null {
  const rest = text.slice(from);
  const match =
    kind === 'xml' ? /^\s*<\/agenthub:forward>/i.exec(rest) : /^\s*(?:```+|~~~+)/.exec(rest);
  if (!match) return null;
  return from + match[0].length;
}

export function extractForwardBlocks(text: string | null | undefined): ForwardExtractionResult {
  if (typeof text !== 'string' || !text.includes('agenthub:forward')) {
    return { strippedText: text ?? '', forwards: [] };
  }
  const spans: Array<{ start: number; end: number; forward: ExtractedForward }> = [];
  OPENER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OPENER_RE.exec(text)) !== null) {
    const kind = match[0].startsWith('<') ? 'xml' : 'fence';
    const after = match.index + match[0].length;
    const braceAt = text.indexOf('{', after);
    if (braceAt < 0 || !/^[\s]*$/.test(text.slice(after, braceAt))) continue;
    const parsed = parseJsonObject(text, braceAt);
    if (!parsed) continue;
    const closer = consumeCloser(text, parsed.end, kind);
    if (closer == null) continue;
    const forward = normalizeForward(parsed.value);
    if (!forward) continue;
    spans.push({ start: match.index, end: closer, forward });
    OPENER_RE.lastIndex = closer;
  }
  if (spans.length === 0) return { strippedText: text, forwards: [] };
  let stripped = '';
  let cursor = 0;
  const forwards: ExtractedForward[] = [];
  for (const span of spans) {
    stripped += text.slice(cursor, span.start);
    forwards.push(span.forward);
    cursor = span.end;
  }
  stripped += text.slice(cursor);
  return { strippedText: stripped.replace(/\n{3,}/g, '\n\n').trim(), forwards };
}
