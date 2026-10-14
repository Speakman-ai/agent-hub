/**
 * Scheduled AI digests for chat channels. A channel's digest (cron + timezone)
 * summarizes either the channel's own messages or a project's activity over
 * the window since the previous run, with a one-shot model on the digest
 * owner's engine credentials, and posts it into the channel as a system
 * message whose body carries ref chips.
 *
 * Runs on the daily-summary minute ticker (`daily-summary-schedule.ts`). An
 * empty window posts nothing but still advances the cursor; a failed run keeps
 * the cursor so the next run covers the same window.
 *
 * Store: `hub-chat-digests-store.ts`. Routes: `/api/chat/channels/:id/digest`.
 */
import { HUB_ASSISTANT_AGENT_ID } from '../shared/utils/hub.js';
import { formatHubChatRefToken, parseHubChatRefTokens } from '../shared/utils/hubChatRefTokens.js';
import { getDb } from './db.js';
import { isLocalBundledServer } from './auth.js';
import { cronMatches, parseCron } from './cron-match.js';
import { isValidTimeZone } from './daily-summary-schedule.js';
import { resolveOneShotEngine } from './engine-resolver.js';
import { runOneShotPromptWithFailover, type OneShotFailoverOutcome } from './one-shot-failover.js';
import { resolveSessionCliSpawnEnv } from './per-user-cli-spawn.js';
import { resolveHubEngineAndModel } from './hub-assistant.js';
import { hubWorkspaceCwd } from './hub-daily-summary.js';
import { formatCardShortId } from './kanban-short-id.js';
import { findProject } from './project-model.js';
import { canViewProject } from './project-visibility.js';
import { buildRefViewer, resolveBodyRefs, type RefLookups } from './hub-chat-refs.js';
import { locateChatMarkdownCode } from './hub-chat-markdown.js';
import { appendMessage, getChannel, getMember } from './hub-chat-store.js';
import { broadcastHubChatMessage } from './hub-chat-broadcast.js';
import { HUB_CHAT_MESSAGE_EVENT } from './hub-chat-events.js';
import { getUserById } from './users-store.js';
import {
  advanceChannelDigestWindow,
  getChannelDigest,
  listEnabledChannelDigests,
  recordChannelDigestFailure,
  type ChannelDigestRow,
} from './hub-chat-digests-store.js';
import type {
  AppConfig,
  BroadcastFn,
  HubChatChannelRow,
  HubChatMessageRow,
  HubChatRefKind,
  Project,
} from './types.js';

export const CHANNEL_DIGEST_PAYLOAD_TYPE = 'channel_digest';

export { DIGEST_DEFAULT_LOOKBACK_MS } from './hub-chat-digests-store.js';

const MAX_CHANNEL_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 400;
const MAX_PROJECT_ITEMS = 40;
const MAX_FOOTER_REFS = 8;
const GENERATE_TIMEOUT_MS = 90_000;

export interface DigestWindow {
  /** Inclusive ISO start. */
  start: string;
  /** Exclusive ISO end. */
  end: string;
}

/**
 * The window a run covers: from the stored cursor up to now. The cursor only
 * moves when a run posts or skips, so a failed span is always retried and
 * windows never gap or overlap. Nothing is cut off however long the cursor
 * has been stuck; the fact lists are capped instead and say so.
 */
export function digestWindow(row: Pick<ChannelDigestRow, 'window_start'>, now: Date): DigestWindow {
  const end = now.toISOString();
  const startMs = Date.parse(row.window_start);
  if (Number.isNaN(startMs) || startMs > now.getTime()) return { start: end, end };
  return { start: row.window_start, end };
}

function minuteKey(ms: number): number {
  return Math.floor(ms / 60_000);
}

/**
 * Digests whose cron fires in the minute containing `now`, in their own
 * timezone. A digest that already ran in this minute is not due again.
 */
export function selectDueChannelDigests(
  now: Date,
  rows: ReadonlyArray<ChannelDigestRow>,
): ChannelDigestRow[] {
  const nowMinute = minuteKey(now.getTime());
  return rows.filter((row) => {
    if (!row.enabled) return false;
    const cron = parseCron(row.cron);
    if (!cron) return false;
    const tz = isValidTimeZone(row.time_zone) ? row.time_zone : 'UTC';
    if (!cronMatches(cron, now, tz)) return false;
    const last = row.last_run_at ? Date.parse(row.last_run_at) : NaN;
    return Number.isNaN(last) || minuteKey(last) !== nowMinute;
  });
}

/** One summarizable item with the chip that names it, when it has one. */
export interface DigestFactItem {
  line: string;
  ref: { kind: HubChatRefKind; targetId: string; label: string } | null;
}

export interface DigestFacts {
  scope: 'channel' | 'project';
  items: DigestFactItem[];
  /** True when a list hit its cap, so older items in the window were left out. */
  truncated: boolean;
}

/** True when the window holds nothing worth summarizing. */
export function isDigestWindowEmpty(facts: DigestFacts): boolean {
  return facts.items.length === 0;
}

function oneLine(text: string, max: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function token(kind: HubChatRefKind, targetId: string, label: string): string {
  return formatHubChatRefToken(label, kind, targetId) ?? label;
}

interface ChannelMessageFactRow {
  author_kind: string;
  author_user_id: string | null;
  author_agent_id: string | null;
  body: string;
  created_at: string;
}

/**
 * The channel's live messages in the window, oldest first. Earlier digests are
 * left out, so a digest alone never counts as activity.
 */
export function collectChannelDigestFacts(channelId: string, window: DigestWindow): DigestFacts {
  const rows = getDb()
    .prepare(
      `SELECT author_kind, author_user_id, author_agent_id, body, created_at
       FROM hub_chat_messages
       WHERE channel_id = ? AND deleted_at IS NULL
         AND created_at >= ? AND created_at < ?
         AND IFNULL(json_extract(payload_json, '$.type'), '') <> ?
       ORDER BY seq DESC LIMIT ?`,
    )
    .all(
      channelId,
      window.start,
      window.end,
      CHANNEL_DIGEST_PAYLOAD_TYPE,
      MAX_CHANNEL_MESSAGES,
    ) as ChannelMessageFactRow[];
  const items: DigestFactItem[] = rows
    .reverse()
    .filter((r) => r.body.trim().length > 0)
    .map((r) => {
      const who =
        r.author_kind === 'user'
          ? (getUserById(r.author_user_id ?? '')?.username ?? 'a member')
          : r.author_kind === 'agent'
            ? `agent ${r.author_agent_id ?? ''}`.trim()
            : r.author_kind;
      return { line: `[${r.created_at}] ${who}: ${oneLine(r.body, MAX_MESSAGE_CHARS)}`, ref: null };
    });
  return { scope: 'channel', items, truncated: rows.length >= MAX_CHANNEL_MESSAGES };
}

/**
 * A project's activity in the window: cards created or changed, native PRs
 * updated, finalize runs that finished, and support tickets opened. Sessions
 * are left out because they are private to their owners.
 */
export function collectProjectDigestFacts(projectId: string, window: DigestWindow): DigestFacts {
  const db = getDb();
  const items: DigestFactItem[] = [];
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);

  const cards = db
    .prepare(
      `SELECT c.id, c.title, c.short_id, b.card_prefix, col.name AS column_name,
              datetime(c.created_at) >= datetime(?) AS is_new
       FROM kanban_cards c
       JOIN kanban_boards b ON b.id = c.board_id
       LEFT JOIN kanban_columns col ON col.id = c.column_id
       WHERE b.project_id = ?
         AND datetime(c.updated_at) >= datetime(?) AND datetime(c.updated_at) < datetime(?)
       ORDER BY c.updated_at DESC LIMIT ?`,
    )
    .all(window.start, projectId, window.start, window.end, MAX_PROJECT_ITEMS) as Array<{
    id: string;
    title: string;
    short_id: number | null;
    card_prefix: string | null;
    column_name: string | null;
    is_new: number;
  }>;
  for (const c of cards) {
    const label = formatCardShortId(c.card_prefix, c.short_id) ?? oneLine(c.title, 60);
    items.push({
      line: `Card ${token('card', c.id, label)} "${oneLine(c.title, 160)}" ${
        c.is_new ? 'created' : 'updated'
      }, now in ${c.column_name ?? 'unknown column'}`,
      ref: { kind: 'card', targetId: c.id, label },
    });
  }

  const prs = db
    .prepare(
      `SELECT number, title, status FROM pull_requests
       WHERE project_id = ? AND updated_at >= ? AND updated_at < ?
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(projectId, startMs, endMs, MAX_PROJECT_ITEMS) as Array<{
    number: number;
    title: string;
    status: string;
  }>;
  for (const pr of prs) {
    const targetId = `${projectId}#${pr.number}`;
    const label = `PR #${pr.number}`;
    items.push({
      line: `${token('pr', targetId, label)} "${oneLine(pr.title, 160)}" is ${pr.status}`,
      ref: { kind: 'pr', targetId, label },
    });
  }

  const runs = db
    .prepare(
      `SELECT r.card_id, r.status, r.branch, r.failure_reason, c.title, c.short_id, b.card_prefix
       FROM finalize_runs r
       LEFT JOIN kanban_cards c ON c.id = r.card_id
       LEFT JOIN kanban_boards b ON b.id = c.board_id
       WHERE r.project_id = ? AND r.ended_at >= ? AND r.ended_at < ?
       ORDER BY r.ended_at DESC LIMIT ?`,
    )
    .all(projectId, startMs, endMs, MAX_PROJECT_ITEMS) as Array<{
    card_id: string;
    status: string;
    branch: string;
    failure_reason: string | null;
    title: string | null;
    short_id: number | null;
    card_prefix: string | null;
  }>;
  for (const r of runs) {
    const label =
      formatCardShortId(r.card_prefix, r.short_id) ?? (r.title ? oneLine(r.title, 60) : null);
    const subject = label ? `for card ${token('card', r.card_id, label)}` : `on ${r.branch}`;
    const reason = r.failure_reason ? ` (${oneLine(r.failure_reason, 120)})` : '';
    items.push({
      line: `Finalize run ${subject} finished: ${r.status}${reason}`,
      ref: label ? { kind: 'card', targetId: r.card_id, label } : null,
    });
  }

  const tickets = db
    .prepare(
      `SELECT id, subject, severity, status FROM support_tickets
       WHERE project_id = ?
         AND datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(projectId, window.start, window.end, MAX_PROJECT_ITEMS) as Array<{
    id: string;
    subject: string;
    severity: string;
    status: string;
  }>;
  for (const t of tickets) {
    const label = oneLine(t.subject || 'Support ticket', 60);
    items.push({
      line: `Support ticket ${token('ticket', t.id, label)} opened (${t.severity}, ${t.status})`,
      ref: { kind: 'ticket', targetId: t.id, label },
    });
  }

  const truncated = [cards, prs, runs, tickets].some((l) => l.length >= MAX_PROJECT_ITEMS);
  return { scope: 'project', items, truncated };
}

const SYSTEM_PROMPT = [
  'You write a short scheduled digest for an Agent Hub chat channel.',
  'Use ONLY the facts provided. Do not invent work, people, tickets, or outcomes.',
  'Output markdown only: no preamble, no closing remarks, no code fences around the reply.',
  'Lead with the most important outcomes, then group the rest in a short bullet list.',
  'Facts contain reference tokens shaped like @[label](kind:id). When you mention that item,',
  'copy its token exactly as written so it renders as a link. Never alter or invent a token.',
  'Keep it under 200 words.',
].join('\n');

export function buildDigestPrompt(input: {
  facts: DigestFacts;
  window: DigestWindow;
  channelName: string;
  projectName: string | null;
  timeZone: string;
}): string {
  const subject =
    input.facts.scope === 'project'
      ? `activity in project "${input.projectName ?? 'unknown'}"`
      : `messages in channel "${input.channelName || 'this channel'}"`;
  return [
    `Summarize ${subject} between ${input.window.start} and ${input.window.end} (UTC).`,
    `The reader's timezone is ${input.timeZone}.`,
    '',
    ...(input.facts.truncated
      ? ['The window is long, so only the most recent items are listed. Say so briefly.', '']
      : []),
    'Facts:',
    ...input.facts.items.map((i) => `- ${i.line}`),
  ].join('\n');
}

/**
 * The posted body: a header, the model's summary, and, when the summary kept
 * no chips, a line of chips for the items it covered.
 */
export function buildDigestBody(input: {
  markdown: string;
  facts: DigestFacts;
  window: DigestWindow;
}): string {
  const header = `**Digest** · ${formatWindow(input.window)}`;
  let body = `${header}\n\n${input.markdown.trim()}`;
  if (parseHubChatRefTokens(input.markdown, locateChatMarkdownCode).length === 0) {
    const seen = new Set<string>();
    const chips: string[] = [];
    for (const item of input.facts.items) {
      if (!item.ref) continue;
      const key = `${item.ref.kind}:${item.ref.targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      chips.push(token(item.ref.kind, item.ref.targetId, item.ref.label));
      if (chips.length >= MAX_FOOTER_REFS) break;
    }
    if (chips.length > 0) body += `\n\nRefs: ${chips.join(' ')}`;
  }
  return body;
}

function formatWindow(window: DigestWindow): string {
  const fmt = (iso: string) => iso.slice(0, 16).replace('T', ' ');
  return `${fmt(window.start)} to ${fmt(window.end)} UTC`;
}

export interface ChannelDigestRunDeps {
  config: AppConfig;
  broadcast?: BroadcastFn;
  findProject?: (projectId: string) => Project | null;
  getProjects?: () => Project[];
  /** Working directory for the one-shot run; defaults to the Hub workspace. */
  cwd?: string;
  resolveEngine?: typeof resolveOneShotEngine;
  runFailover?: (
    input: Parameters<typeof runOneShotPromptWithFailover>[0],
    cfg: AppConfig,
  ) => Promise<OneShotFailoverOutcome>;
  /** Whether the owner can still see the project. Fails closed. */
  ownerCanViewProject?: (userId: string, orgId: string, projectId: string) => boolean;
  log?: (msg: string) => void;
}

export type ChannelDigestRunResult =
  | { status: 'posted'; messageId: string }
  | { status: 'skipped'; reason: 'empty_window' }
  | { status: 'cancelled'; reason: string }
  | { status: 'error'; error: string };

/**
 * True when `current` is still the digest a run started from: same config,
 * same owner, not edited since, and the cursor still where the run's window
 * starts. A replaced or disabled digest must not receive
 * an old run's post or cursor.
 */
export function isSameDigestConfig(
  started: ChannelDigestRow,
  current: ChannelDigestRow | null,
): boolean {
  return (
    !!current &&
    current.enabled === 1 &&
    current.cron === started.cron &&
    current.time_zone === started.time_zone &&
    current.scope === started.scope &&
    current.project_id === started.project_id &&
    current.owner_user_id === started.owner_user_id &&
    current.updated_at === started.updated_at &&
    current.window_start === started.window_start
  );
}

function defaultOwnerCanViewProject(userId: string, orgId: string, projectId: string): boolean {
  try {
    if (isLocalBundledServer()) return true;
    const project = findProject(projectId);
    if (!project) return false;
    return canViewProject(project, buildRefViewer(userId, orgId, false).visibility);
  } catch {
    return false;
  }
}

async function generateDigestMarkdown(
  deps: ChannelDigestRunDeps,
  ownerUserId: string,
  prompt: string,
): Promise<string> {
  const config = deps.config;
  const hubPick = resolveHubEngineAndModel(config, ownerUserId);
  const resolved = await (deps.resolveEngine ?? resolveOneShotEngine)(config, {
    userId: ownerUserId,
    agentId: HUB_ASSISTANT_AGENT_ID,
    preferred: hubPick.engine,
    preferredModel: hubPick.model,
  });
  const outcome = await (deps.runFailover ?? runOneShotPromptWithFailover)(
    {
      engine: resolved.engine,
      model: resolved.model,
      prompt,
      systemPrompt: SYSTEM_PROMPT,
      cwd: deps.cwd ?? hubWorkspaceCwd(),
      timeoutMs: GENERATE_TIMEOUT_MS,
      userId: ownerUserId,
      agentId: HUB_ASSISTANT_AGENT_ID,
      buildEnv: (engine) =>
        resolveSessionCliSpawnEnv({
          cfg: config,
          ownerId: ownerUserId,
          credsOwnerId: ownerUserId,
          engine,
        }),
      scope: 'channel-digest',
      claudePermissionMode: 'bypassPermissions',
    },
    config,
  );
  const markdown = outcome.output.trim();
  if (!markdown || (outcome.detailed.code !== 0 && outcome.detailed.code !== null)) {
    throw new Error(outcome.detailed.stderr?.trim() || 'Digest generation failed');
  }
  return markdown;
}

/**
 * Runs one digest now: checks the owner may still post it, collects the
 * window, skips an empty one, otherwise generates and posts. Records the
 * outcome on the digest row. Never throws.
 */
export async function runChannelDigest(
  row: ChannelDigestRow,
  now: Date,
  deps: ChannelDigestRunDeps,
): Promise<ChannelDigestRunResult> {
  const window = digestWindow(row, now);
  const fail = (error: string): ChannelDigestRunResult => {
    try {
      // A failure belongs to this config only; a replacement keeps its own status.
      if (isSameDigestConfig(row, getChannelDigest(row.channel_id))) {
        recordChannelDigestFailure(row.channel_id, error);
      }
    } catch {
      /* the row may be gone; nothing to record */
    }
    return { status: 'error', error };
  };
  try {
    const channel: HubChatChannelRow | null = getChannel(row.channel_id);
    if (!channel || channel.archived_at) return fail('Channel is archived or gone');
    // The owner's credentials pay for the run and their access vouches for
    // what it reads, so they must still be in the channel.
    if (!getMember(channel.id, row.owner_user_id)) {
      return fail('The digest owner is no longer a member of this channel');
    }
    const lookupProject = deps.findProject ?? findProject;
    let project: Project | null = null;
    let facts: DigestFacts;
    if (row.scope === 'project') {
      const canView = deps.ownerCanViewProject ?? defaultOwnerCanViewProject;
      project = row.project_id ? lookupProject(row.project_id) : null;
      if (!project || !canView(row.owner_user_id, channel.org_id, project.id)) {
        return fail('The digest owner can no longer view this project');
      }
      facts = collectProjectDigestFacts(project.id, window);
    } else {
      facts = collectChannelDigestFacts(channel.id, window);
    }

    if (isDigestWindowEmpty(facts)) {
      if (
        !advanceChannelDigestWindow(row.channel_id, window.start, {
          status: 'skipped',
          windowEnd: window.end,
        })
      ) {
        return { status: 'cancelled', reason: 'The digest window moved during the run' };
      }
      return { status: 'skipped', reason: 'empty_window' };
    }

    const timeZone = isValidTimeZone(row.time_zone) ? row.time_zone : 'UTC';
    const markdown = await generateDigestMarkdown(
      deps,
      row.owner_user_id,
      buildDigestPrompt({
        facts,
        window,
        channelName: channel.name,
        projectName: project?.name ?? null,
        timeZone,
      }),
    );
    const lookups: RefLookups = {
      findProject: (id) => lookupProject(id),
      getProjects: () => deps.getProjects?.() ?? [],
    };
    // Chips the owner cannot see are flattened to plain labels.
    const resolved = resolveBodyRefs(
      lookups,
      buildRefViewer(row.owner_user_id, channel.org_id, isLocalBundledServer()),
      buildDigestBody({ markdown, facts, window }),
    );
    // The model call took a while: everything checked before it may have
    // changed. Re-check and post in one transaction so nothing can change
    // between the check and the write. A stale run records nothing, so it
    // never touches a replacement digest's status or cursor.
    const canView = deps.ownerCanViewProject ?? defaultOwnerCanViewProject;
    const outcome = getDb()
      .transaction(
        (): { cancelled: string } | { live: HubChatChannelRow; message: HubChatMessageRow } => {
          if (!isSameDigestConfig(row, getChannelDigest(row.channel_id))) {
            return { cancelled: 'Digest was removed, disabled or changed during the run' };
          }
          const live = getChannel(channel.id);
          if (!live || live.archived_at) return { cancelled: 'Channel is archived or gone' };
          if (!getMember(live.id, row.owner_user_id)) {
            return { cancelled: 'The digest owner is no longer a member of this channel' };
          }
          if (project && !canView(row.owner_user_id, live.org_id, project.id)) {
            return { cancelled: 'The digest owner can no longer view this project' };
          }
          const message = appendMessage({
            channelId: channel.id,
            authorKind: 'system',
            body: resolved.body,
            refs: resolved.refs,
            payload: {
              type: CHANNEL_DIGEST_PAYLOAD_TYPE,
              scope: row.scope,
              projectId: project?.id ?? null,
              windowStart: window.start,
              windowEnd: window.end,
            },
          });
          // Checked above, so this cannot miss; if it ever did, throwing
          // rolls the message back with it.
          if (
            !advanceChannelDigestWindow(row.channel_id, window.start, {
              status: 'posted',
              windowEnd: window.end,
              messageId: message.id,
            })
          ) {
            throw new Error('The digest window moved during the run');
          }
          return { live, message };
        },
      )
      .immediate();
    if ('cancelled' in outcome) return { status: 'cancelled', reason: outcome.cancelled };
    // Only after commit: a rolled-back message is never announced.
    broadcastHubChatMessage(deps.broadcast, HUB_CHAT_MESSAGE_EVENT, outcome.live, outcome.message);
    return { status: 'posted', messageId: outcome.message.id };
  } catch (err) {
    (deps.log ?? console.error)(
      `[channel-digest] ${row.channel_id} failed: ${(err as Error).message}`,
    );
    return fail((err as Error).message || 'Digest failed');
  }
}

// Digests running right now, so a slow model run is never started twice.
const inFlight = new Set<string>();
// `${channelId}:${minute}` already started this minute, so a failed run (which
// keeps its cursor and last_run_at) is not retried every tick within the minute.
const startedThisMinute = new Set<string>();
let startedMinute = -1;

/** Exposed for tests. */
export function resetChannelDigestGuards(): void {
  inFlight.clear();
  startedThisMinute.clear();
  startedMinute = -1;
}

export interface ChannelDigestTickDeps extends ChannelDigestRunDeps {
  listDigests?: () => ChannelDigestRow[];
  run?: typeof runChannelDigest;
}

/** Starts every due digest and waits for them. Never throws. */
export async function runChannelDigestTick(now: Date, deps: ChannelDigestTickDeps): Promise<void> {
  const minute = minuteKey(now.getTime());
  if (minute !== startedMinute) {
    startedThisMinute.clear();
    startedMinute = minute;
  }
  let rows: ChannelDigestRow[];
  try {
    rows = (deps.listDigests ?? listEnabledChannelDigests)();
  } catch (err) {
    (deps.log ?? console.error)(`[channel-digest] list failed: ${(err as Error).message}`);
    return;
  }
  const run = deps.run ?? runChannelDigest;
  const jobs: Promise<unknown>[] = [];
  for (const row of selectDueChannelDigests(now, rows)) {
    const key = `${row.channel_id}:${minute}`;
    if (inFlight.has(row.channel_id) || startedThisMinute.has(key)) continue;
    inFlight.add(row.channel_id);
    startedThisMinute.add(key);
    jobs.push(
      run(row, now, deps)
        .catch(() => undefined)
        .finally(() => inFlight.delete(row.channel_id)),
    );
  }
  await Promise.all(jobs);
}
