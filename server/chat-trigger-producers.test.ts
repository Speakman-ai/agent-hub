/**
 * The chat trigger router drops a broadcast that does not carry its own
 * occurrence id (see `chat-trigger-router.ts`). This scan keeps every producer
 * of those events stamping the id, so a new producer cannot silently go quiet.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SKIP = new Set(['node_modules', 'test', 'default-skills', 'data']);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** The object literal around each `type: '<event>'` occurrence. */
function broadcastsOf(type: string): { file: string; literal: string }[] {
  const hits: { file: string; literal: string }[] = [];
  for (const file of sources(ROOT)) {
    const text = readFileSync(file, 'latin1');
    const needle = `type: '${type}'`;
    for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
      const open = text.lastIndexOf('{', i);
      const close = text.indexOf('}', i);
      hits.push({ file: path.relative(ROOT, file), literal: text.slice(open, close + 1) });
    }
  }
  return hits;
}

describe('chat trigger producers carry occurrence ids', () => {
  it('every card_moved broadcast stamps a moveId and its column', () => {
    const hits = broadcastsOf('card_moved').filter((h) => !h.file.startsWith('chat-trigger'));
    expect(hits.length).toBeGreaterThanOrEqual(7);
    for (const h of hits) {
      expect(h.literal, h.file).toMatch(/moveId:/);
      expect(h.literal, h.file).toMatch(/columnName:/);
    }
  });

  it('a review request broadcast carries its request stamp', () => {
    const service = readFileSync(path.join(ROOT, 'native-pr/service.ts'), 'latin1');
    const at = service.indexOf("action: requested ? 'review_requested'");
    expect(at).toBeGreaterThan(-1);
    expect(service.slice(at, service.indexOf('});', at))).toMatch(/reviewRequestedAt/);
  });

  it('card_created and cron_finished carry what the router keys and filters on', () => {
    const created = broadcastsOf('card_created').filter((h) => h.file === 'routes/board.ts');
    expect(created).toHaveLength(1);
    expect(created[0]!.literal).toMatch(/cardId:[\s\S]*columnName:/);
    const cron = broadcastsOf('cron_finished').filter((h) => h.file === 'heartbeat.ts');
    expect(cron).toHaveLength(1);
    for (const field of ['cronId:', 'logId:', 'ownerUserId:', 'cronShared:']) {
      expect(cron[0]!.literal).toContain(field);
    }
  });
});
