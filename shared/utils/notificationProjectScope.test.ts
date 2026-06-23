import { describe, it, expect } from 'vitest';
import {
  shouldNotifyUserForProject,
  resolveNotificationProjectId,
  shouldDeliverProjectNotification,
} from './notificationProjectScope.js';

describe('shouldNotifyUserForProject', () => {
  it('allows only the project owner', () => {
    expect(shouldNotifyUserForProject('ryan', 'ryan')).toBe(true);
    expect(shouldNotifyUserForProject('ryan', 'kevin')).toBe(false);
  });

  it('allows everyone when the project has no owner (legacy)', () => {
    expect(shouldNotifyUserForProject(null, 'ryan')).toBe(true);
    expect(shouldNotifyUserForProject(undefined, 'kevin')).toBe(true);
    // Ownerless even for an unattributed recipient — pre-migration installs
    // must not go silent.
    expect(shouldNotifyUserForProject(null, null)).toBe(true);
  });

  it('excludes an unattributed recipient from an OWNED project (security)', () => {
    // Regression: a legacy/unattributed device (no user_id) on a multi-user
    // server must NOT receive an owner-only / private project's notifications.
    expect(shouldNotifyUserForProject('ryan', null)).toBe(false);
    expect(shouldNotifyUserForProject('ryan', undefined)).toBe(false);
    expect(shouldNotifyUserForProject('ryan', '')).toBe(false);
  });

  it('honors localBypass even for a mismatched or unknown recipient', () => {
    expect(shouldNotifyUserForProject('ryan', 'kevin', { localBypass: true })).toBe(true);
    expect(shouldNotifyUserForProject('ryan', null, { localBypass: true })).toBe(true);
  });
});

describe('resolveNotificationProjectId', () => {
  const agents = [{ id: 'a1', projectId: 'p1' }];

  it('prefers explicit projectId', () => {
    expect(resolveNotificationProjectId({ projectId: 'p9' }, agents)).toBe('p9');
  });

  it('falls back to agent.projectId', () => {
    expect(resolveNotificationProjectId({ agentId: 'a1' }, agents)).toBe('p1');
  });
});

describe('shouldDeliverProjectNotification', () => {
  const projects = [
    { id: 'mine', ownerUserId: 'ryan' },
    { id: 'theirs', ownerUserId: 'kevin' },
  ];

  it('suppresses another user project event', () => {
    expect(
      shouldDeliverProjectNotification(
        { type: 'thread_created', projectId: 'theirs' },
        'ryan',
        projects,
      ),
    ).toBe(false);
  });

  it('allows the owner project event', () => {
    expect(
      shouldDeliverProjectNotification({ type: 'card_moved', projectId: 'mine' }, 'ryan', projects),
    ).toBe(true);
  });

  it('suppresses an owned project event for an unknown recipient (no localBypass)', () => {
    expect(
      shouldDeliverProjectNotification({ type: 'card_moved', projectId: 'mine' }, null, projects),
    ).toBe(false);
  });

  it('delivers to an unknown recipient when localBypass is set (no per-user boundary)', () => {
    expect(
      shouldDeliverProjectNotification(
        { type: 'card_moved', projectId: 'mine' },
        null,
        projects,
        [],
        {
          localBypass: true,
        },
      ),
    ).toBe(true);
  });

  it('still delivers events for unknown / ownerless projects', () => {
    expect(
      shouldDeliverProjectNotification(
        { type: 'card_moved', projectId: 'unlisted' },
        null,
        projects,
      ),
    ).toBe(true);
  });
});
