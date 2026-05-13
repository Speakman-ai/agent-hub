/**
 * Tests for server/session-ownership.ts — the helper layer that
 * gates session reads/mutations to the user that created them.
 *
 * The module reads through the shared `getDb()` + `listUsers()`
 * surfaces, so we drive it via real DB operations against the test
 * harness from `test/setup.ts`.
 */

import './test/setup.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, stmts } from './db.js';
import {
  setSessionOwner,
  getSessionOwner,
  inheritOwnerFromSession,
  userOwnsSession,
  resolveOwnerUserId,
  resolveAutonomousOwnerUserId,
  resetOrgOwnerCache,
  backfillSessionOwners,
  getOrgOwnerUserId,
} from './session-ownership.js';
import config from './config.js';
import { initOrgsDb, setOrgsDbPathForTests } from './orgs.js';
import { createUser } from './users-store.js';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';

function seedSession(agentId = '_test_agent', name = 'fixture'): string {
  const id = uuidv4();
  if (!stmts) throw new Error('stmts not initialized');
  stmts.createSession.run(id, agentId, name, 'claude-code', 'sonnet', 0, 0, 1);
  return id;
}

describe('session-ownership helpers', () => {
  beforeEach(() => {
    // Wipe the sessions table so each spec starts from a known state.
    getDb().exec('DELETE FROM sessions');
    resetOrgOwnerCache();
  });

  it('setSessionOwner / getSessionOwner roundtrip', () => {
    const id = seedSession();
    expect(getSessionOwner(id)).toBeNull();
    setSessionOwner(id, 'user-1');
    expect(getSessionOwner(id)).toBe('user-1');
  });

  it('setSessionOwner is a no-op when ownerId is null', () => {
    const id = seedSession();
    setSessionOwner(id, null);
    expect(getSessionOwner(id)).toBeNull();
  });

  it('inheritOwnerFromSession copies the parent owner', () => {
    const parent = seedSession();
    const child = seedSession();
    setSessionOwner(parent, 'user-2');
    inheritOwnerFromSession(child, parent);
    expect(getSessionOwner(child)).toBe('user-2');
  });

  it('backfillSessionOwners is a no-op when no users exist', () => {
    const id = seedSession();
    expect(getSessionOwner(id)).toBeNull();
    const { updated } = backfillSessionOwners();
    expect(updated).toBe(0);
    expect(getSessionOwner(id)).toBeNull();
  });

  it('userOwnsSession allows everyone when auth is disabled (no apiKey, no JWT setup)', () => {
    // Test setup deletes AGENT_HUB_API_KEY and never calls
    // setupAuth(), so isAuthDisabled() returns true.
    const id = seedSession();
    expect(userOwnsSession(undefined, id)).toBe(true);
    expect(userOwnsSession({ authUserId: 'someone-else' }, id)).toBe(true);
  });

  it('getOrgOwnerUserId does NOT cache a null lookup', () => {
    // Regression for PR #709 review: caching `null` meant that on a
    // fresh self-hosted install, the boot-time `backfillSessionOwners`
    // call would prime the cache with `null` and every subsequent
    // system spawn (cron, webhook reviewer, autonomous dispatch,
    // bug-report intake) would record `owner_user_id = NULL` even
    // after the operator hit `/api/auth/setup`. Strict mode then
    // rejected the actual owner from their own sessions until the
    // next process restart.
    //
    // Fix: only cache positive lookups. listUsers() is a single-row
    // PK lookup; re-running it on every spawn until users exist is
    // cheap and avoids the latch. We prove it here by calling twice
    // through both the orgs-db-not-initialized branch (this test
    // file doesn't init orgs.db) and the `users.length === 0` branch
    // — neither should pin the cache.
    expect(getOrgOwnerUserId()).toBeNull();
    expect(getOrgOwnerUserId()).toBeNull();
    // After resetOrgOwnerCache() (a no-op when nothing was cached)
    // the next call still re-resolves rather than serving stale state.
    resetOrgOwnerCache();
    expect(getOrgOwnerUserId()).toBeNull();
  });

  it('resolveOwnerUserId prefers req.authUserId over the org owner', () => {
    expect(resolveOwnerUserId({ authUserId: 'user-9' })).toBe('user-9');
  });

  it('resolveOwnerUserId returns the cached org owner when no req identity is set', () => {
    // No users in orgs.db under the test harness → null.
    expect(resolveOwnerUserId(undefined)).toBeNull();
    expect(getOrgOwnerUserId()).toBeNull();
  });
});

describe('userOwnsSession — apiKey-only legacy mode', () => {
  beforeEach(() => {
    getDb().exec('DELETE FROM sessions');
    resetOrgOwnerCache();
  });

  it('every authenticated caller passes when apiKey is set but no auth.json exists', () => {
    // Regression for the prod 404 bug: PR a08fccc started gating every
    // `/api/sessions/:sessionId/*` route on `userOwnsSession`, but an
    // install that upgraded from the apiKey-only era has no `auth.json`
    // and an empty `users` table. The apiKey middleware authorizes the
    // caller as `Owner`, but `resolveOwnerUserId` had nothing to map to
    // — `getOrgOwnerUserId()` returned null because the `users` table
    // was empty — so the predicate returned false and every session
    // route 404'd. The test harness leaves `auth.json` absent and
    // `users` empty, which exactly mirrors that prod state.
    const previous = config.apiKey;
    config.apiKey = 'test-key';
    try {
      const id = seedSession();
      setSessionOwner(id, 'creator');
      expect(userOwnsSession({ authUserId: 'anyone' }, id)).toBe(true);
      expect(userOwnsSession(undefined, id)).toBe(true);

      const legacyNullOwner = seedSession();
      expect(userOwnsSession({ authUserId: 'anyone' }, legacyNullOwner)).toBe(true);
      expect(userOwnsSession(undefined, legacyNullOwner)).toBe(true);
    } finally {
      config.apiKey = previous;
    }
  });
});

describe('resolveAutonomousOwnerUserId — owner resolution chain', () => {
  let userA: string;
  let userB: string;
  let enabler: string;

  beforeEach(() => {
    getDb().exec('DELETE FROM sessions');
    resetOrgOwnerCache();
    // Spin up a fresh orgs.db per-spec so `isKnownUserId` (via
    // getUserById) returns true for our seeded ids. The shared
    // `test/setup.ts` does not init orgs.db, so we own that here.
    const dir = mkdtempSync(path.join(tmpdir(), 'session-ownership-test-'));
    setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
    initOrgsDb();
    userA = createUser({ username: `userA-${Date.now()}-${Math.random()}`, passwordHash: 'h' }).id;
    userB = createUser({ username: `userB-${Date.now()}-${Math.random()}`, passwordHash: 'h' }).id;
    enabler = createUser({
      username: `enabler-${Date.now()}-${Math.random()}`,
      passwordHash: 'h',
    }).id;
    // listUsers() ordering decides the org-owner fallback; reset the
    // cache so the fresh DB seeds it on the next call.
    resetOrgOwnerCache();
  });

  it('step 1: prefers card.created_by when it matches a real user', () => {
    const out = resolveAutonomousOwnerUserId(
      { created_by: userA, session_id: null },
      { autonomous_enabled_by: enabler },
    );
    expect(out).toBe(userA);
  });

  it('step 1: ignores card.created_by when it is a free-form string (e.g. an agent id)', () => {
    // Falls through to org-owner because the other two signals are absent.
    const out = resolveAutonomousOwnerUserId(
      { created_by: 'agent-hub-intake', session_id: null },
      { autonomous_enabled_by: null },
    );
    expect(out).toBe(getOrgOwnerUserId());
    expect(out).not.toBe('agent-hub-intake');
  });

  it('step 2: falls back to card.session_id owner when created_by is null', () => {
    const filerSession = seedSession();
    setSessionOwner(filerSession, userB);
    const out = resolveAutonomousOwnerUserId(
      { created_by: null, session_id: filerSession },
      { autonomous_enabled_by: enabler },
    );
    expect(out).toBe(userB);
  });

  it('step 2: skips session lookup when the session has no owner (e.g. pre-migration)', () => {
    const orphanSession = seedSession();
    const out = resolveAutonomousOwnerUserId(
      { created_by: null, session_id: orphanSession },
      { autonomous_enabled_by: enabler },
    );
    expect(out).toBe(enabler);
  });

  it('step 3: falls back to epic.autonomous_enabled_by when card has no signal', () => {
    const out = resolveAutonomousOwnerUserId(
      { created_by: null, session_id: null },
      { autonomous_enabled_by: enabler },
    );
    expect(out).toBe(enabler);
  });

  it('step 3: ignores epic.autonomous_enabled_by when it is not a known user', () => {
    const out = resolveAutonomousOwnerUserId(
      { created_by: null, session_id: null },
      { autonomous_enabled_by: 'not-a-real-user-id' },
    );
    // Falls through to org owner (userA — first user seeded).
    expect(out).toBe(getOrgOwnerUserId());
  });

  it('step 4: falls back to org owner when nothing else resolves', () => {
    const out = resolveAutonomousOwnerUserId(
      { created_by: null, session_id: null },
      { autonomous_enabled_by: null },
    );
    expect(out).toBe(getOrgOwnerUserId());
    // userA is the first user we seeded → it IS the org owner.
    expect(out).toBe(userA);
  });

  it('handles null card and null epic without throwing', () => {
    expect(() => resolveAutonomousOwnerUserId(null, null)).not.toThrow();
    expect(resolveAutonomousOwnerUserId(null, null)).toBe(getOrgOwnerUserId());
  });
});

// Spies aren't strictly needed but keep vi import non-trivially used so
// linters don't flag the import.
void vi;
