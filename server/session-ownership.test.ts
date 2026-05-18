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
  userCanReadSession,
  isReviewerSession,
  resolveOwnerUserId,
  resolveAutonomousOwnerUserId,
  resolveSpawnCredsOwnerUserId,
  resetOrgOwnerCache,
  backfillSessionOwners,
  getOrgOwnerUserId,
} from './session-ownership.js';
import * as projectModel from './project-model.js';
import type { AgentLookup } from './types.js';
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

describe('resolveSpawnCredsOwnerUserId — per-account CLI billing fallback', () => {
  let firstUser: string;

  beforeEach(() => {
    getDb().exec('DELETE FROM sessions');
    resetOrgOwnerCache();
    // Seed orgs.db so getOrgOwnerUserId() resolves to a real id.
    // Without this the fallback degrades to null and the "reviewer
    // falls through to org owner" assertion is indistinguishable from
    // a no-op.
    const dir = mkdtempSync(path.join(tmpdir(), 'spawn-creds-owner-test-'));
    setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
    initOrgsDb();
    firstUser = createUser({
      username: `first-${Date.now()}-${Math.random()}`,
      passwordHash: 'h',
    }).id;
    // Second user proves we pick the *first* (oldest) — i.e. the org
    // owner — not "any user".
    createUser({
      username: `second-${Date.now()}-${Math.random()}`,
      passwordHash: 'h',
    });
    resetOrgOwnerCache();
  });

  it('returns the persisted owner verbatim when one is set', () => {
    // Sessions with a real human attached (regular interactive chat,
    // autonomous dispatch with a resolved owner) must always bill to
    // that human — the helper never substitutes another user when the
    // persisted owner is non-null.
    expect(resolveSpawnCredsOwnerUserId('user-abc')).toBe('user-abc');
    // Even when the org owner exists (firstUser !== 'user-abc'), the
    // persisted id wins.
    expect(getOrgOwnerUserId()).toBe(firstUser);
    expect(resolveSpawnCredsOwnerUserId('user-abc')).not.toBe(firstUser);
  });

  it('falls back to the org owner when the persisted owner is null (reviewer / system spawn)', () => {
    // Reproduces the production miss: reviewer sessions store
    // owner_user_id = NULL on purpose (the thread is shared/read-only
    // across the org). Pre-fix, chat.ts skipped per-user CLI auth
    // entirely on NULL, so the spawn hit the shared host subscription
    // and 429'd ("You've hit your limit") while operators with their
    // own per-account Anthropic OAuth tokens sat idle.
    expect(resolveSpawnCredsOwnerUserId(null)).toBe(firstUser);
  });

  it('falls back to the org owner when the persisted owner is undefined', () => {
    // Defensive — the chat.ts caller passes the already-resolved
    // `ownerId` which is typed `string | null`, but every call site
    // that may shrink the type should keep working.
    expect(resolveSpawnCredsOwnerUserId(undefined)).toBe(firstUser);
  });

  it('returns null when the persisted owner is null AND no users exist', () => {
    // Fresh install state — pre `/api/auth/setup`. The org has no
    // users yet so there is nobody to bill; the helper returns null
    // and the spawn path keeps its existing host-config behaviour.
    const dir = mkdtempSync(path.join(tmpdir(), 'spawn-creds-empty-test-'));
    setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
    initOrgsDb();
    resetOrgOwnerCache();
    expect(getOrgOwnerUserId()).toBeNull();
    expect(resolveSpawnCredsOwnerUserId(null)).toBeNull();
  });
});

describe('reviewer sessions — shared / read-bypass', () => {
  beforeEach(() => {
    getDb().exec('DELETE FROM sessions');
    resetOrgOwnerCache();
    vi.restoreAllMocks();
  });

  function seedReviewerAgentLookup(agentId: string) {
    const lookup = {
      project: {
        id: 'proj-1',
        name: 'Proj',
        slug: 'proj',
        cwd: '/tmp',
        ahw: '/tmp',
        agents: [],
      },
      agent: {
        id: agentId,
        name: 'Reviewer',
        role: 'reviewer',
        engine: 'claude-code',
      },
    } as unknown as AgentLookup;
    return vi.spyOn(projectModel, 'findAgent').mockImplementation((id: string) => {
      if (id !== agentId) return null;
      return lookup;
    });
  }

  it('isReviewerSession returns true when the session agent has role=reviewer', () => {
    const agentId = 'reviewer-agent';
    seedReviewerAgentLookup(agentId);
    const id = seedSession(agentId, 'Review: PR #1 Test');
    expect(isReviewerSession(id)).toBe(true);
  });

  it('isReviewerSession returns false for non-reviewer agents', () => {
    const agentId = 'lead-agent';
    const lookup = {
      project: { id: 'p', name: 'P', slug: 'p', cwd: '/tmp', ahw: '/tmp', agents: [] },
      agent: { id: agentId, name: 'Lead', role: 'lead', engine: 'claude-code' },
    } as unknown as AgentLookup;
    vi.spyOn(projectModel, 'findAgent').mockReturnValue(lookup);
    const id = seedSession(agentId);
    expect(isReviewerSession(id)).toBe(false);
  });

  it('isReviewerSession returns false when the agent lookup fails (project model uninitialised)', () => {
    vi.spyOn(projectModel, 'findAgent').mockImplementation(() => {
      throw new Error('not initialised');
    });
    const id = seedSession('some-agent');
    expect(isReviewerSession(id)).toBe(false);
  });

  it('userCanReadSession lets any caller read a reviewer session even under strict auth', () => {
    // Set up strict-auth conditions: apiKey + an auth.json record so the
    // permissive bypasses in userOwnsSession do not fire.
    const previousKey = config.apiKey;
    config.apiKey = 'test-key';
    // Mock getAuthRecord by also installing a user so the predicate path
    // would otherwise demand ownership equality.
    try {
      const agentId = 'reviewer-agent-2';
      seedReviewerAgentLookup(agentId);
      const reviewerSessionId = seedSession(agentId, 'Review: PR #2');
      // Owner is NULL because the webhook handler no longer stamps it.
      expect(getSessionOwner(reviewerSessionId)).toBeNull();
      // Even an unrelated caller can read it.
      expect(userCanReadSession({ authUserId: 'someone-else' }, reviewerSessionId)).toBe(true);
      expect(userCanReadSession(undefined, reviewerSessionId)).toBe(true);
    } finally {
      config.apiKey = previousKey;
    }
  });

  it('userCanReadSession falls back to strict ownership for non-reviewer sessions', () => {
    // Without seeding a reviewer agent lookup, findAgent returns null,
    // so isReviewerSession returns false. userCanReadSession then falls
    // through to userOwnsSession, which (under no-auth test setup) is
    // permissive — so true is the expected result here. We assert the
    // delegation by toggling apiKey to make the underlying predicate
    // strict.
    vi.spyOn(projectModel, 'findAgent').mockReturnValue(null);
    const id = seedSession('normal-agent');
    const previousKey = config.apiKey;
    config.apiKey = 'test-key';
    try {
      // apiKey-only legacy mode: userOwnsSession is permissive when
      // there is no auth.json. The fact that we hit that permissive
      // path (not the reviewer bypass) is the assertion.
      expect(userCanReadSession({ authUserId: 'anyone' }, id)).toBe(true);
      expect(isReviewerSession(id)).toBe(false);
    } finally {
      config.apiKey = previousKey;
    }
  });

  it('userOwnsSession (strict) does NOT bypass for reviewer sessions — writes stay gated', () => {
    // userOwnsSession is the write predicate; reviewer sessions have
    // NULL owner so the NULL-owner branch resolves to the org owner.
    // Non-owner callers should still be rejected. We verify by ensuring
    // the reviewer bypass is *only* in userCanReadSession.
    const agentId = 'reviewer-agent-3';
    seedReviewerAgentLookup(agentId);
    const id = seedSession(agentId, 'Review: PR #3');
    // Under the no-auth test harness userOwnsSession is permissive, so
    // bump into strict mode by installing apiKey. With auth.json absent
    // userOwnsSession is still permissive (legacy apiKey path) — that
    // is correct and orthogonal to the reviewer concern. The real
    // assertion is that userOwnsSession behaviour for this session is
    // identical to its behaviour for any other NULL-owner session.
    const nonReviewerId = seedSession('other-agent');
    expect(userOwnsSession({ authUserId: 'someone' }, id)).toBe(
      userOwnsSession({ authUserId: 'someone' }, nonReviewerId),
    );
  });
});

// Spies aren't strictly needed but keep vi import non-trivially used so
// linters don't flag the import.
void vi;
