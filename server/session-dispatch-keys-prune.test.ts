/**
 * Session forward dispatch keys are the permanent record that a card started.
 * Auto start rescans old cards, so pruning one would let its card start again.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getDb, getStmts } from './db.js';
import { OrchestrateLaunchStore } from './orchestrate-launch-store.js';

describe('session dispatch key pruning', () => {
  it('keeps completed Session forward keys past the 30-day retention', () => {
    const db = getDb();
    const stmts = getStmts();
    const insert = db.prepare(
      `INSERT INTO session_dispatch_keys (owner_user_id, idem_key, request_hash, session_id, mode, created_at)
       VALUES ('prune-u', ?, 'h', ?, 'manual', datetime('now', '-40 days'))`,
    );
    insert.run('session-forward:chat-old:7:a:0', 'child-1');
    insert.run('card:other-old', 'child-2');
    insert.run('session-forward:chat-old:8:b:0', null);

    stmts.pruneSessionDispatchKeys.run();

    const left = (
      db
        .prepare("SELECT idem_key FROM session_dispatch_keys WHERE owner_user_id = 'prune-u'")
        .all() as Array<{ idem_key: string }>
    ).map((row) => row.idem_key);
    // The started card stays; an unrelated key and an abandoned claim go.
    expect(left).toEqual(['session-forward:chat-old:7:a:0']);
  });
});

describe('Orchestrate auto start cancels', () => {
  it('outlive the old 30-day retention', () => {
    const db = new Database(':memory:');
    const store = new OrchestrateLaunchStore(db);
    db.prepare(
      "INSERT INTO orchestrate_auto_start_cancels (dispatch_key, created_at) VALUES (?, datetime('now', '-90 days'))",
    ).run('session-forward:chat:1:a:0');
    // A later cancel used to prune old ones first.
    store.cancel('session-forward:chat:2:b:0');
    expect(store.isCancelled('session-forward:chat:1:a:0')).toBe(true);
    expect(store.listCancelled('chat').sort()).toEqual([
      'session-forward:chat:1:a:0',
      'session-forward:chat:2:b:0',
    ]);
  });
});

describe('Orchestrate message order on the real schema', () => {
  it('numbers every new message and never reuses a number after deletes', () => {
    const db = getDb();
    const store = new OrchestrateLaunchStore(db);
    const triggers = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_orchestrate_%'",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(triggers).toEqual(
      expect.arrayContaining([
        'trg_orchestrate_message_order_ai',
        'trg_orchestrate_message_order_ad',
        'trg_orchestrate_launch_leave',
        'trg_orchestrate_launch_enter',
      ]),
    );
    const before =
      (
        db
          .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'orchestrate_message_order'")
          .get() as { seq: number } | undefined
      )?.seq ?? 0;
    db.prepare("INSERT INTO orchestrate_message_order (message_id) VALUES ('probe-1')").run();
    db.prepare("DELETE FROM orchestrate_message_order WHERE message_id = 'probe-1'").run();
    db.prepare("INSERT INTO orchestrate_message_order (message_id) VALUES ('probe-2')").run();
    expect(store.messageOrder('probe-2')).toBe(before + 2);
    db.prepare("DELETE FROM orchestrate_message_order WHERE message_id = 'probe-2'").run();
  });
});
