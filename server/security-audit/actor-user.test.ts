import '../test/setup.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as authorUser from '../native-pr/author-user.js';
import * as memberships from '../memberships-store.js';
import {
  resolveSecurityAutoPrActor,
  isSecurityAutoMergeEnabled,
  isEligibleSecurityActor,
} from './actor-user.js';
import type { Project } from '../types.js';

function project(securityAutoPr: Project['securityAutoPr']): Project {
  return { id: 'p1', name: 'P1', gitHost: 'agenthub', securityAutoPr } as unknown as Project;
}

describe('resolveSecurityAutoPrActor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when no actor is configured', () => {
    expect(resolveSecurityAutoPrActor(project(undefined))).toBeNull();
    expect(resolveSecurityAutoPrActor(project({ enabled: true }))).toBeNull();
    expect(resolveSecurityAutoPrActor(project({ actorUserId: '   ' }))).toBeNull();
  });

  it('returns the configured actor when it resolves to a known Hub user', () => {
    vi.spyOn(authorUser, 'isKnownHubUserId').mockReturnValue(true);
    expect(resolveSecurityAutoPrActor(project({ actorUserId: 'user-1' }))).toBe('user-1');
  });

  it('FAIL-SAFE: returns null when the configured actor no longer resolves', () => {
    // The user was removed since it was configured — do not attribute work to a
    // stale identity.
    vi.spyOn(authorUser, 'isKnownHubUserId').mockReturnValue(false);
    expect(resolveSecurityAutoPrActor(project({ actorUserId: 'ghost' }))).toBeNull();
  });

  it('trims surrounding whitespace before resolving', () => {
    const spy = vi.spyOn(authorUser, 'isKnownHubUserId').mockReturnValue(true);
    expect(resolveSecurityAutoPrActor(project({ actorUserId: '  user-1  ' }))).toBe('user-1');
    expect(spy).toHaveBeenCalledWith('user-1');
  });
});

describe('isEligibleSecurityActor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('auth-enabled: accepts an Admin or Owner member of the org', () => {
    const role = vi.spyOn(memberships, 'getMembershipRole');
    role.mockReturnValue('Admin');
    expect(isEligibleSecurityActor('u1', 'org1')).toBe(true);
    role.mockReturnValue('Owner');
    expect(isEligibleSecurityActor('u1', 'org1')).toBe(true);
  });

  it('auth-enabled: rejects a plain User-role member', () => {
    vi.spyOn(memberships, 'getMembershipRole').mockReturnValue('User');
    expect(isEligibleSecurityActor('u1', 'org1')).toBe(false);
  });

  // The reviewer-caught hole: a real Hub user who is NOT a member of the org
  // (role lookup → null) must be rejected in an auth-enabled deployment, even
  // though isKnownHubUserId(user) is true. The no-auth fallback must NOT apply.
  it('auth-enabled: rejects a known Hub user who is not a member of the org', () => {
    vi.spyOn(memberships, 'getMembershipRole').mockReturnValue(null);
    vi.spyOn(authorUser, 'attributionOptional').mockReturnValue(false);
    vi.spyOn(authorUser, 'isKnownHubUserId').mockReturnValue(true);
    expect(isEligibleSecurityActor('non-member', 'org1')).toBe(false);
  });

  it('auth-enabled: rejects when no org context is present', () => {
    vi.spyOn(authorUser, 'attributionOptional').mockReturnValue(false);
    vi.spyOn(authorUser, 'isKnownHubUserId').mockReturnValue(true);
    expect(isEligibleSecurityActor('u1', undefined)).toBe(false);
  });

  it('no-auth/local: falls back to the known-Hub-user bar when no role resolves', () => {
    vi.spyOn(memberships, 'getMembershipRole').mockReturnValue(null);
    vi.spyOn(authorUser, 'attributionOptional').mockReturnValue(true);
    const known = vi.spyOn(authorUser, 'isKnownHubUserId');
    known.mockReturnValue(true);
    expect(isEligibleSecurityActor('local-user', 'org1')).toBe(true);
    // A sentinel / unknown id is still rejected even in no-auth mode.
    known.mockReturnValue(false);
    expect(isEligibleSecurityActor('system', 'org1')).toBe(false);
  });
});

describe('isSecurityAutoMergeEnabled', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('is false when autoMerge is off, regardless of actor', () => {
    vi.spyOn(authorUser, 'isKnownHubUserId').mockReturnValue(true);
    expect(isSecurityAutoMergeEnabled(project({ actorUserId: 'user-1' }))).toBe(false);
    expect(isSecurityAutoMergeEnabled(project({ autoMerge: false, actorUserId: 'user-1' }))).toBe(
      false,
    );
  });

  it('is false when autoMerge is on but the actor does not resolve (fail-safe)', () => {
    vi.spyOn(authorUser, 'isKnownHubUserId').mockReturnValue(false);
    expect(isSecurityAutoMergeEnabled(project({ autoMerge: true, actorUserId: 'ghost' }))).toBe(
      false,
    );
  });

  it('is true only when autoMerge is on AND a valid actor is configured', () => {
    vi.spyOn(authorUser, 'isKnownHubUserId').mockReturnValue(true);
    expect(isSecurityAutoMergeEnabled(project({ autoMerge: true, actorUserId: 'user-1' }))).toBe(
      true,
    );
  });
});
