/**
 * Persistence for project chat triggers (`project_chat_triggers`, schema in
 * `hub-chat-schema.ts`). Routing lives in `chat-trigger-router.ts`; access
 * rules in `routes/project-chat-triggers.ts`.
 */
import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import type { ChatTriggerEvent, ChatTriggerFilter } from '../shared/utils/chatTriggers.js';

export interface ChatTriggerRow {
  id: string;
  project_id: string;
  event: string;
  filter_json: string | null;
  channel_id: string;
  /** Google Chat space id (`AAAA`, not `spaces/AAAA`), posted as `created_by`. */
  google_chat_space_id: string | null;
  enabled: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export function parseTriggerFilter(raw: string | null): ChatTriggerFilter {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as ChatTriggerFilter) : {};
  } catch {
    return {};
  }
}

function filterJson(filter: ChatTriggerFilter | undefined | null): string | null {
  if (!filter) return null;
  const clean = Object.fromEntries(
    Object.entries(filter).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)),
  );
  return Object.keys(clean).length ? JSON.stringify(clean) : null;
}

export function getTrigger(id: string): ChatTriggerRow | null {
  return (
    (getDb().prepare('SELECT * FROM project_chat_triggers WHERE id = ?').get(id) as
      | ChatTriggerRow
      | undefined) ?? null
  );
}

export function listTriggersForProject(projectId: string): ChatTriggerRow[] {
  return getDb()
    .prepare('SELECT * FROM project_chat_triggers WHERE project_id = ? ORDER BY created_at, id')
    .all(projectId) as ChatTriggerRow[];
}

/** Enabled triggers for one project event, oldest first. */
export function listEnabledTriggers(projectId: string, event: ChatTriggerEvent): ChatTriggerRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM project_chat_triggers
       WHERE project_id = ? AND event = ? AND enabled = 1
       ORDER BY created_at, id`,
    )
    .all(projectId, event) as ChatTriggerRow[];
}

export function createTrigger(input: {
  projectId: string;
  event: ChatTriggerEvent;
  channelId: string;
  filter?: ChatTriggerFilter | null;
  googleChatSpaceId?: string | null;
  enabled?: boolean;
  createdBy: string | null;
}): ChatTriggerRow {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO project_chat_triggers
         (id, project_id, event, filter_json, channel_id, google_chat_space_id, enabled, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.projectId,
      input.event,
      filterJson(input.filter),
      input.channelId,
      input.googleChatSpaceId || null,
      input.enabled === false ? 0 : 1,
      input.createdBy,
    );
  return getTrigger(id) as ChatTriggerRow;
}

export function updateTrigger(
  id: string,
  patch: {
    event?: ChatTriggerEvent;
    channelId?: string;
    filter?: ChatTriggerFilter | null;
    /** null clears the Google Chat destination. */
    googleChatSpaceId?: string | null;
    enabled?: boolean;
  },
): ChatTriggerRow | null {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.event !== undefined) {
    sets.push('event = ?');
    args.push(patch.event);
  }
  if (patch.channelId !== undefined) {
    sets.push('channel_id = ?');
    args.push(patch.channelId);
  }
  if (patch.filter !== undefined) {
    sets.push('filter_json = ?');
    args.push(filterJson(patch.filter));
  }
  if (patch.googleChatSpaceId !== undefined) {
    sets.push('google_chat_space_id = ?');
    args.push(patch.googleChatSpaceId || null);
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    args.push(patch.enabled ? 1 : 0);
  }
  if (sets.length) {
    getDb()
      .prepare(
        `UPDATE project_chat_triggers SET ${sets.join(', ')}, updated_at = ${NOW} WHERE id = ?`,
      )
      .run(...args, id);
  }
  return getTrigger(id);
}

export function deleteTrigger(id: string): boolean {
  return getDb().prepare('DELETE FROM project_chat_triggers WHERE id = ?').run(id).changes > 0;
}

/**
 * Posts an occurrence through a trigger at most once. `write` runs inside the
 * transaction that records the occurrence: it either commits with its message
 * or, if it throws, rolls back so a later broadcast can try again. Returns
 * null when the occurrence was already posted.
 */
export function postOccurrenceOnce<T extends { id: string }>(
  triggerId: string,
  occurrenceKey: string,
  write: () => T,
): T | null {
  const conn = getDb();
  return conn
    .transaction(() => {
      const seen = conn
        .prepare(
          'SELECT 1 FROM project_chat_trigger_posts WHERE trigger_id = ? AND occurrence_key = ?',
        )
        .get(triggerId, occurrenceKey);
      if (seen) return null;
      const result = write();
      conn
        .prepare(
          `INSERT INTO project_chat_trigger_posts (trigger_id, occurrence_key, message_id)
           VALUES (?, ?, ?)`,
        )
        .run(triggerId, occurrenceKey, result.id);
      return result;
    })
    .immediate();
}

/** Forgets posted occurrences older than `maxAgeMs`; duplicates arrive within seconds. */
export function pruneTriggerPosts(maxAgeMs: number, now = Date.now()): number {
  const cutoff = new Date(now - maxAgeMs).toISOString();
  return getDb().prepare('DELETE FROM project_chat_trigger_posts WHERE created_at < ?').run(cutoff)
    .changes;
}
