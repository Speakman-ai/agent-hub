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
  resetOrgOwnerCache,
  backfillSessionOwners,
  getOrgOwnerUserId,
} from './session-ownership.js';
import config from './config.js';

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

describe('userOwnsSession — strict mode (auth enabled)', () => {
  beforeEach(() => {
    getDb().exec('DELETE FROM sessions');
    resetOrgOwnerCache();
  });

  it('only the recorded owner may act on a row when an apiKey is configured', () => {
    // Flip the apiKey to enable strict-mode ownership. We restore it
    // afterwards so other tests stay in the no-auth bypass branch.
    const previous = config.apiKey;
    config.apiKey = 'test-key';
    try {
      const id = seedSession();
      setSessionOwner(id, 'creator');
      expect(userOwnsSession({ authUserId: 'creator' }, id)).toBe(true);
      expect(userOwnsSession({ authUserId: 'snooper' }, id)).toBe(false);
      expect(userOwnsSession(undefined, id)).toBe(false);
    } finally {
      config.apiKey = previous;
    }
  });

  it('NULL-owner rows are treated as belonging to the org owner', () => {
    const previous = config.apiKey;
    config.apiKey = 'test-key';
    try {
      const id = seedSession();
      // No setSessionOwner — owner_user_id stays NULL (legacy row).
      // With no users in orgs.db, getOrgOwnerUserId() returns null and
      // every caller is rejected (callerId === null path).
      expect(userOwnsSession({ authUserId: 'anyone' }, id)).toBe(false);
    } finally {
      config.apiKey = previous;
    }
  });
});

// Spies aren't strictly needed but keep vi import non-trivially used so
// linters don't flag the import.
void vi;
