import { describe, it, expect } from 'vitest';
import {
  sessionIdPrefixFromHeadBranch,
  canonicalSessionBranch,
  resolveSessionForPrHeadBranch,
} from './pr-preview.js';
import type { SessionRow } from '../types.js';

function session(id: string, agentId: string, deletedAt: string | null = null): SessionRow {
  return { id, agent_id: agentId, deleted_at: deletedAt } as unknown as SessionRow;
}

describe('sessionIdPrefixFromHeadBranch', () => {
  it('extracts the 8-hex session prefix a native PR head branch encodes', () => {
    expect(sessionIdPrefixFromHeadBranch('agent-hub/dev/session-abcd1234')).toBe('abcd1234');
    // agentId can contain slashes/hyphens — the session-<hex> tail is what matters.
    expect(sessionIdPrefixFromHeadBranch('agent-hub/agent-hub-dev/session-1941eb90')).toBe(
      '1941eb90',
    );
  });

  it('lower-cases the prefix for a case-insensitive id lookup', () => {
    expect(sessionIdPrefixFromHeadBranch('agent-hub/dev/session-ABCD1234')).toBe('abcd1234');
  });

  it('returns null for branches that do not encode a session', () => {
    expect(sessionIdPrefixFromHeadBranch('main')).toBeNull();
    expect(sessionIdPrefixFromHeadBranch('feature/login')).toBeNull();
    // A resolve-PR session pins directly onto an arbitrary head branch.
    expect(sessionIdPrefixFromHeadBranch('release-2.1')).toBeNull();
    expect(sessionIdPrefixFromHeadBranch('')).toBeNull();
    expect(sessionIdPrefixFromHeadBranch(null)).toBeNull();
    expect(sessionIdPrefixFromHeadBranch(undefined)).toBeNull();
  });

  it('requires exactly 8 hex — a short or non-hex suffix does not match', () => {
    expect(sessionIdPrefixFromHeadBranch('agent-hub/dev/session-abc')).toBeNull();
    expect(sessionIdPrefixFromHeadBranch('agent-hub/dev/session-zzzzzzzz')).toBeNull();
  });
});

describe('canonicalSessionBranch', () => {
  it('reconstructs agent-hub/<agentId>/session-<first8>', () => {
    expect(
      canonicalSessionBranch({ id: 'abcd1234-0000-4000-8000-0000000000ff', agent_id: 'dev' }),
    ).toBe('agent-hub/dev/session-abcd1234');
  });
});

describe('resolveSessionForPrHeadBranch', () => {
  const P = 'proj-1'; // the requesting project

  it('resolves the session that owns the head branch (full branch + project match)', () => {
    const row = session('abcd1234-0000-0000-0000-000000000000', 'dev');
    const resolved = resolveSessionForPrHeadBranch(
      'agent-hub/dev/session-abcd1234',
      P,
      (prefix) => {
        expect(prefix).toBe('abcd1234');
        return [row];
      },
      () => P,
    );
    expect(resolved).toBe(row);
  });

  it('returns null when the branch encodes no session (never calls the lookup)', () => {
    let called = false;
    const resolved = resolveSessionForPrHeadBranch(
      'main',
      P,
      () => {
        called = true;
        return [];
      },
      () => P,
    );
    expect(resolved).toBeNull();
    expect(called).toBe(false);
  });

  it('returns null when no session row matches the prefix', () => {
    const resolved = resolveSessionForPrHeadBranch(
      'agent-hub/dev/session-cafe0001',
      P,
      () => [],
      () => P,
    );
    expect(resolved).toBeNull();
  });

  it('treats a soft-deleted session as gone (no reachable worktree)', () => {
    const resolved = resolveSessionForPrHeadBranch(
      'agent-hub/dev/session-abcd1234',
      P,
      () => [session('abcd1234-0000-0000-0000-000000000000', 'dev', '2026-08-27 00:00:00')],
      () => P,
    );
    expect(resolved).toBeNull();
  });

  it('rejects a prefix collision whose full canonical branch differs (8-hex is not the boundary)', () => {
    // Same 8-hex, but a DIFFERENT agent id → different canonical branch. A
    // branch crafted to reuse another session's prefix must not resolve it.
    const impostor = session('abcd1234-0000-0000-0000-000000000000', 'evil-agent');
    const resolved = resolveSessionForPrHeadBranch(
      'agent-hub/dev/session-abcd1234',
      P,
      () => [impostor],
      () => P, // even if it were in the same project
    );
    expect(resolved).toBeNull();
  });

  it('rejects a full-branch match that belongs to a different project (tenant scope)', () => {
    const otherTenant = session('abcd1234-0000-0000-0000-000000000000', 'dev');
    const resolved = resolveSessionForPrHeadBranch(
      'agent-hub/dev/session-abcd1234',
      P,
      () => [otherTenant],
      () => 'some-other-project', // resolves to a different project
    );
    expect(resolved).toBeNull();
  });

  it('picks the correct session out of a prefix-collision set across tenants', () => {
    const wrongTenant = session('abcd1234-1111-0000-0000-000000000000', 'dev');
    const right = session('abcd1234-2222-0000-0000-000000000000', 'dev');
    const projectOf = (s: SessionRow) => (s === right ? P : 'other-project');
    const resolved = resolveSessionForPrHeadBranch(
      'agent-hub/dev/session-abcd1234',
      P,
      () => [wrongTenant, right],
      projectOf,
    );
    // Both share the 8-hex prefix AND the canonical branch; only the one in the
    // requesting project may be returned.
    expect(resolved).toBe(right);
  });
});
