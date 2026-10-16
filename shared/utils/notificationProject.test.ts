import { describe, expect, it } from 'vitest';
import { notificationProjectName } from './notificationProject';

const projects = [
  { id: 'agent-hub', name: 'Agent Hub' },
  { id: 'blank', name: '  ' },
];

describe('notificationProjectName', () => {
  it('resolves the project id to its display name', () => {
    expect(notificationProjectName({ projectId: 'agent-hub', data: null }, projects)).toBe(
      'Agent Hub',
    );
  });

  it('falls back to data.projectId when the row has no projectId column', () => {
    expect(
      notificationProjectName({ projectId: null, data: { projectId: 'agent-hub' } }, projects),
    ).toBe('Agent Hub');
  });

  it('shows the id when the project is unknown or has no name', () => {
    expect(notificationProjectName({ projectId: 'gone', data: null }, projects)).toBe('gone');
    expect(notificationProjectName({ projectId: 'blank', data: null }, projects)).toBe('blank');
    expect(notificationProjectName({ projectId: 'agent-hub', data: null }, undefined)).toBe(
      'agent-hub',
    );
  });

  it('returns null for notifications not tied to a project', () => {
    expect(notificationProjectName({ projectId: null, data: {} }, projects)).toBeNull();
  });
});
