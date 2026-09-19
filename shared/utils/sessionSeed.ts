/**
 * Opening user-message seed from a Gmail message/thread or personal todo.
 */

/** Long email bodies are clamped so a single message can't blow the seed cap. */
const MAX_SEED_BODY = 8_000;

function clean(value: string | null | undefined): string {
  return (value || '').trim();
}

/** Trim, collapse trailing whitespace, and ellipsize a body to MAX_SEED_BODY. */
function clampBody(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_SEED_BODY) return trimmed;
  return `${trimmed.slice(0, MAX_SEED_BODY - 1).trimEnd()}…`;
}

/** A Gmail message/thread as loaded by the pane, narrowed to what a seed needs. */
export interface EmailSessionSeedInput {
  subject?: string | null;
  from?: string | null;
  to?: string | null;
  snippet?: string | null;
  bodyText?: string | null;
  /** A safe reopen URL (Gmail permalink); callers pass the validated value. */
  deepLink?: string | null;
}

/**
 * Build the opening user message for a session seeded from an email. Prefers the
 * full body over the snippet; omits any header line whose value is empty.
 */
export function buildEmailSessionSeed(input: EmailSessionSeedInput): string {
  const subject = clean(input.subject);
  const from = clean(input.from);
  const to = clean(input.to);
  const deepLink = clean(input.deepLink);
  const body = clampBody(clean(input.bodyText) || clean(input.snippet));

  const lines: string[] = ["Here's an email I'd like to work on with you.", ''];
  lines.push(`**Subject:** ${subject || '(no subject)'}`);
  if (from) lines.push(`**From:** ${from}`);
  if (to) lines.push(`**To:** ${to}`);
  if (deepLink) lines.push(`**Link:** ${deepLink}`);
  if (body) {
    lines.push('');
    lines.push(body);
  }
  return lines.join('\n');
}

/** A personal todo, narrowed to the fields a session seed reads. */
export interface TodoSessionSeedInput {
  title?: string | null;
  notes?: string | null;
  /** Human origin label, e.g. "From email" (see captureTodo.todoOriginLabel). */
  originLabel?: string | null;
  /** A safe reopen URL for the origin (see captureTodo.todoOriginDeepLink). */
  deepLink?: string | null;
}

/**
 * Build the opening user message for a session seeded from a todo. Title falls
 * back to a generic label; notes and origin lines are omitted when empty.
 */
export function buildTodoSessionSeed(input: TodoSessionSeedInput): string {
  const title = clean(input.title) || 'Untitled todo';
  const notes = clampBody(clean(input.notes));
  const originLabel = clean(input.originLabel);
  const deepLink = clean(input.deepLink);

  const lines: string[] = ["Here's a todo I'd like to work on with you.", ''];
  lines.push(`**Todo:** ${title}`);
  if (originLabel || deepLink) {
    const origin = [originLabel, deepLink].filter(Boolean).join(' — ');
    lines.push(`**Origin:** ${origin}`);
  }
  if (notes) {
    lines.push('');
    lines.push(notes);
  }
  return lines.join('\n');
}
